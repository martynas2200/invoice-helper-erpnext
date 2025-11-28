frappe.ui.form.on("Purchase Invoice", {
    async refresh(frm) {
        const button = frm.add_custom_button(__("Prefill from Pending Document"), () =>
            prefill_from_pending_dialog(frm)
        );
        if (frm.is_new()) {
            button.removeClass("btn-default").addClass("btn-primary");
        } else {
            button.removeClass("btn-primary").addClass("btn-default");
        }
    },
    async after_save(frm) {
        if (frm._pending_file) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await attach_pending_document_file(frm, frm._pending_file);
            // Clear the flag so we don't attach again on subsequent saves
            frm._pending_file = null;
            // call get_docinfo
            frm.get_docinfo();
        }
    },
});

function prefill_from_pending_dialog(frm) {
    const d = new frappe.ui.Dialog({
        title: __("Prefill from Pending Document"),
        fields: [
            {
                fieldname: "pending",
                label: __("Pending Document"),
                fieldtype: "Link",
                get_query: () => ({
                    filters: { type: "Purchase" },
                    order_by: "`tabPending Document`.`id` desc",
                }),
                options: "Pending Document",
                reqd: 1,
                description: __("Type = Purchase"),
            },
            {
                fieldname: "prefill_type",
                label: __("Prefill Type"),
                fieldtype: "Select",
                options: [
                    { label: __("Amazon Textract Tables"), value: "textract_tables" },
                    { label: __("Local table extraction"), value: "local_tables" },
                    { label: __("Barcodes Only"), value: "barcodes" },
                ],
                default: "textract_tables",
                reqd: 1,
            },
            {
                fieldname: "should_header_be_prefilled",
                label: __("Prefill Header Fields"),
                fieldtype: "Check",
                default: frm.is_new() ? 1 : 0,
                description: __(
                    "If available, Bill No, Posting Date, Due Date, Supplier from Pending Document"
                ),
            },
        ],
        primary_action_label: "Prefill",
        primary_action: async (values) => {
            if (!values?.pending) return;
            d.hide();
            await prefill_from_pending(
                frm,
                values.pending,
                values.prefill_type,
                values.should_header_be_prefilled
            );
        },
    });
    d.show();
}

async function prefill_from_pending(
    frm,
    pendingName,
    prefillType = "textract_tables",
    shouldHeaderBePrefilled = true
) {
    // Load Pending Document with children
    const pd = await frappe.db.get_doc("Pending Document", pendingName);

    frm._pending_file = pd.file;

    if (shouldHeaderBePrefilled) {
        if (!frm.doc.bill_no && pd.bill_no) {
            await frm.set_value("bill_no", pd.bill_no);
        }
        if (!frm.doc.set_posting_time && pd.bill_date) {
            await frm.set_value("set_posting_time", 1);
            await frm.set_value("posting_date", pd.bill_date);
            await frm.set_value("posting_time", "07:00:00");
        }
        if (!frm.doc.due_date && pd.due_date) {
            await frm.set_value("due_date", pd.due_date);
        } else if (!frm.doc.due_date) {
            // add 1 month to posting date
            const postingDate = frm.doc.posting_date
                ? frappe.datetime.str_to_obj(frm.doc.posting_date)
                : new Date();
            postingDate.setMonth(postingDate.getMonth() + 1);
            await frm.set_value("due_date", frappe.datetime.obj_to_str(postingDate));
        }
        if ((pd.party_type || "").toLowerCase() === "supplier" && pd.party && !frm.doc.supplier) {
            await frm.set_value("supplier", pd.party);
        }
    }

    // Prepare data based on prefill type
    let rows = [];
    let barcodes = [];

    if (prefillType === "local_tables") {
        // rows = Array.isArray(pd.items) ? pd.items : [];
        rows = await selectTableAndColumnsFromTextractData(pd, "purchase", "local_tables");
        barcodes = rows.map((r) => r.barcode).filter(Boolean);
    } else if (prefillType === "barcodes") {
        const barcodeTable = Array.isArray(pd.re_barcodes) ? pd.re_barcodes : [];
        barcodes = barcodeTable
            .map((b) => (b.barcode ? b.barcode.trim() : ""))
            .filter((b) => b.length > 0);
        rows = barcodes.map((barcode) => ({ barcode }));
    } else {
        rows = await selectTableAndColumnsFromTextractData(pd, "purchase");
        barcodes = rows.map((r) => r.barcode).filter(Boolean);
    }

    // Map barcodes to item codes
    let mapped = {};
    if (barcodes.length) {
        try {
            const res = await frappe.call({
                method: "invoice_helper.api.get_item_codes_for_barcodes",
                args: { barcodes: barcodes },
            });
            if (res.message) {
                mapped = res.message;
            }
        } catch (err) {
            console.error("Error fetching Item Barcodes:", err);
        }
    }

    let matched = 0,
        unmatched = 0;
    for (const r of rows) {
        const item_code = r.barcode && mapped[r.barcode] ? mapped[r.barcode].item_code : null;
        const child = frm.add_child("items", {});
        if (item_code) {
            child.item_code = item_code;
            child.item_name = mapped[r.barcode].item_name;
            child.uom = mapped[r.barcode].uom || mapped[r.barcode].stock_uom;
            matched++;
        } else {
            // Leave item_code empty as requested; keep a hint in description
            child.description = r.barcode ? __("Barcode: {0}", [r.barcode]) : __("No barcode");
            unmatched++;
            // A dialog asking if user wants to create missing items could be added here
            //
        }
        if (prefillType !== "barcodes") {
            if (r.quantity) child.qty = r.quantity;
            if (r.price) child.rate = r.price;
            if (r.total) child.amount = r.total; // ERPNext will recompute on save
        }
    }
    frm.refresh_field("items");

    const typeLabel =
        prefillType === "local_tables"
            ? __("Local extraction")
            : prefillType === "textract_tables"
            ? __("Amazon Textract")
            : __("Regular expression: Barcodes");
    frappe.show_alert({
        message: __("Used {0}. Items - Matched: {1}, Unmatched: {2}", [
            typeLabel,
            matched,
            unmatched,
        ]),
        indicator: matched && !unmatched ? "green" : unmatched ? "orange" : "blue",
    });
}
function extractBarcodeFromText(text) {
    // Look for 7, 8, 12, or 13 consecutive digits
    // Can be embedded in text like "Milk 330ml 5900512300481 Poland"
    const barcodeMatch = text.match(/\b(\d{7,8}|\d{12,13})\b/);
    return barcodeMatch ? barcodeMatch[1] : null;
}

function detectColumnType(values, headerText = "") {
    let barcodeScore = 0,
        quantityScore = 0,
        priceScore = 0;

    for (const val of values) {
        const text = (val || "").toString().trim();
        if (!text) continue;

        const barcode = extractBarcodeFromText(text);
        if (barcode) {
            barcodeScore += 2;
        } else if (/^\d+$/.test(text) && text.length >= 5) {
            barcodeScore += 1;
        }

        const num = parseFloat(text);
        if (!isNaN(num) && num > 0 && num < 10000 && /^[\d,.\s]+$/.test(text)) {
            quantityScore += 1;
        }

        if (/^[\d,.\s]+$/.test(text) && (text.includes(".") || text.includes(","))) {
            priceScore += 1;
        }
    }

    if (barcodeScore > 0 && barcodeScore >= quantityScore && barcodeScore >= priceScore) {
        return "barcode";
    } else if (
        (headerText.toLowerCase().includes("price") ||
            headerText.toLowerCase().includes("kaina")) &&
        priceScore > 0
    ) {
        return "price";
    } else if (
        (headerText.toLowerCase().includes("quantity") ||
            headerText.toLowerCase().includes("kiekis")) &&
        quantityScore > 0
    ) {
        return "quantity";
    }

    return "unknown";
}

// Extract column values from all rows for analysis
function getColumnValues(rows, colIndex) {
    return rows
        .slice(1) // Skip header row
        .map((row) => (row[colIndex] || {}).text || "")
        .filter((v) => v.trim());
}

async function selectTableAndColumnsFromTextractData(pendingDoc, docType, variable = "tables") {
    return new Promise((resolve) => {
        let tables = [];
        if (pendingDoc.extraction_json) {
            try {
                const data = JSON.parse(pendingDoc.extraction_json);
                tables = data[variable] || [];
            } catch (e) {
                console.warn("Could not parse extraction_json", e);
            }
        }

        if (!tables || tables.length === 0) {
            frappe.show_alert({
                message: __("No tables found in the document"),
                indicator: "red",
            });
            resolve([]);
            return;
        }

        // If only one table, skip selection and go straight to column mapping
        let selectedTable = tables[0];
        if (tables.length > 1) {
            // Show dialog to select table
            const d = new frappe.ui.Dialog({
                title: __("Select Table"),
                fields: [
                    {
                        fieldname: "table_info",
                        fieldtype: "HTML",
                        label: __("Multiple tables found. Choose the one containing items:"),
                    },
                ],
                primary_action_label: "Next",
                primary_action: () => {
                    d.hide();
                    showColumnMappingDialog(selectedTable, resolve);
                },
            });

            // Add table selection buttons
            const tableInfo = d.fields_dict.table_info.$wrapper;
            tables.forEach((table, idx) => {
                const button =
                    $(`<button class="btn btn-default" style="margin: 5px; display: block; width: 100%; padding: 10px;">
					${__("Table")} ${idx + 1} (${table.rows.length} ${__("rows")}, ${table.rows[0]?.length || 0} ${__(
                        "columns"
                    )}) - ${__("Confidence")}: ${(table.confidence || 0).toFixed(1)}%
				</button>`);
                button.click(() => {
                    selectedTable = table;
                    d.hide();
                    showColumnMappingDialog(selectedTable, resolve);
                });
                tableInfo.append(button);
            });

            d.show();
            return; // Exit and wait for user selection
        }

        // Column mapping dialog
        showColumnMappingDialog(selectedTable, resolve);
    });
}

function showColumnMappingDialog(table, resolve) {
    if (!table.rows || table.rows.length < 2) {
        frappe.show_alert({ message: __("Table has insufficient rows"), indicator: "red" });
        resolve([]);
        return;
    }

    const numCols = table.rows[0].length;
    const fields = [
        {
            fieldname: "mapping_info",
            fieldtype: "HTML",
            label: __("Column Mapping"),
        },
    ];

    // Create column selection fields
    const columnDetection = {};
    for (let colIdx = 0; colIdx < numCols; colIdx++) {
        const columnHeader = (table.rows[0][colIdx] || {}).text || "";
        const values = getColumnValues(table.rows, colIdx);
        const detectedType = detectColumnType(values, columnHeader); // needs improvement
        columnDetection[colIdx] = detectedType;
        const headerText = `${__("Column")} ${colIdx + 1} (${columnHeader})`;
        fields.push({
            fieldname: `col_${colIdx}_type`,
            fieldtype: "Select",
            label: headerText,
            options: [
                { label: "-", value: "" },
                { label: __("Barcode"), value: "barcode" },
                { label: __("Quantity"), value: "quantity" },
                { label: __("Price"), value: "price" },
            ],
            default: detectedType !== "unknown" ? detectedType : "",
            description: values.slice(0, 3).join("; "),
        });
    }

    const d = new frappe.ui.Dialog({
        title: __("Map Columns"),
        fields: fields,
        primary_action_label: __("Extract"),
        primary_action: (values) => {
            const mappedRows = extractMappedRows(table, values);
            // check if there multiple `barcode`, `quantity` or `price` columns were selected
            const selectedTypes = Object.values(values).filter((v) => v);
            const duplicates = selectedTypes.filter(
                (item, index) => selectedTypes.indexOf(item) !== index
            );
            if (duplicates.length > 0) {
                frappe.show_alert({
                    message: __("Please ensure each column type is selected only once."),
                    indicator: "red",
                });
                return;
            }

            d.hide();
            resolve(mappedRows);
        },
    });

    // Add preview of column contents below the info
    const info = d.fields_dict.mapping_info.$wrapper;
    const preview =
        $(`<table class="table table-bordered" style="font-size: 11px; max-height: 200px; overflow-y: auto;">
		<tbody></tbody>
	</table>`);

    // Show header and first 3 data rows
    for (let rowIdx = 0; rowIdx < Math.min(4, table.rows.length); rowIdx++) {
        const row = table.rows[rowIdx];
        const tr = $("<tr>");
        for (let colIdx = 0; colIdx < row.length; colIdx++) {
            const cell = row[colIdx];
            const text = (cell.text || "").substring(0, 20);
            $(`<td>${text}</td>`).appendTo(tr);
        }
        preview.find("tbody").append(tr);
    }

    info.append(preview);
    d.show();
}

function extractMappedRows(table, columnMapping) {
    const rows = [];
    let hasHeader = true; // Assume first row is header

    // double check if first row looks like a header
    const firstRowText = (table.rows[0] || [])
        .map((cell) => (cell.text || "").toLowerCase())
        .join(" ");
    if (
        !/^(nr|item|barcode|qty|quantity|price|amount|rate|total|kaina|kiekis|suma|barkodas|kodas)/i.test(
            firstRowText
        )
    ) {
        hasHeader = false;
    }

    const startIdx = hasHeader ? 1 : 0;

    // Extract rows based on column mapping
    for (let rowIdx = startIdx; rowIdx < table.rows.length; rowIdx++) {
        const row = table.rows[rowIdx];
        const mapped = {};

        for (let colIdx = 0; colIdx < row.length; colIdx++) {
            const fieldName = columnMapping[`col_${colIdx}_type`];
            if (fieldName) {
                const cellText = (row[colIdx].text || "").trim();
                let value = cellText;

                // For barcode fields, extract barcode from text if present
                if (fieldName === "barcode") {
                    const barcode = extractBarcodeFromText(cellText);
                    value = barcode || cellText;
                } else {
                    // For numeric fields (quantity, price), normalize numbers
                    value = cellText.replace(/\s/g, "").replace(",", ".");
                }

                mapped[fieldName] = value || cellText;
            }
        }

        // Only add row if it has at least one mapped field
        if (Object.keys(mapped).length > 0) {
            rows.push(mapped);
        }
    }

    return rows;
}

async function attach_pending_document_file(frm, pendingFile) {
    try {
        const fileDoc = await frappe.db.get_doc("File", pendingFile);

        if (fileDoc) {
            // POST /api/method/upload_file
            const attachment = {
                is_private: fileDoc.is_private,
                folder: fileDoc.folder,
                library_file_name: fileDoc.name,
                doctype: frm.doc.doctype,
                docname: frm.doc.name,
            };
            frappe.call({
                method: "frappe.handler.upload_file",
                args: attachment,
                callback: function (r) {
                    if (r.message) {
                        console.log("File attached successfully:", r.message);
                    }
                },
            });

            console.log("File attached to Purchase Invoice:", pendingFile);
            frappe.show_alert({
                message: __("File attached"),
                indicator: "green",
            });
        } else {
            console.warn("File document not found for:", pendingFile);
        }
    } catch (err) {
        console.error("Error attaching file:", err);
        frappe.show_alert({
            message: __("Could not attach file from Pending Document: {0}", [err.message]),
            indicator: "orange",
        });
    }
}
