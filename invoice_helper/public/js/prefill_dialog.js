frappe.provide("invoice_helper");

invoice_helper.after_save_hook = async function (frm) {
    // Only proceed if there is a pending file to attach
    if (!frm || !frm._pending_file) {
        return;
    }

    // Small delay to ensure the document is fully saved and named
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Capture and clear the flag early to avoid repeated attachments
    const pendingFile = frm._pending_file;
    frm._pending_file = null;

    try {
        await invoice_helper.attach_pending_document_file_to_form(frm, pendingFile);

        if (frm._pending_document) {
            await frappe.db.set_value("Pending Document", frm._pending_document, "status", "Used");
        }
    } catch (err) {
        console.error("Error in invoice_helper.after_save_hook:", err);
    }
};

invoice_helper.prefill_from_pending_dialog = function (
    frm,
    type = "Purchase",
    pendingName = null
) {
    if (!frm) return;

    if (!pendingName && frm._pending_document) {
        pendingName = frm._pending_document;
    }

    const d = new frappe.ui.Dialog({
        title: __("Prefill from Pending Document"),
        fields: [
            {
                fieldname: "pending",
                label: __("Pending Document"),
                fieldtype: "Link",
                get_query: () => ({
                    filters: { type: type },
                    order_by: "`tabPending Document`.`id` desc",
                }),
                options: "Pending Document",
                default: pendingName,
                reqd: 1,
                description: __("Type = {0}", [type]),
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
        primary_action_label: __("Prefill"),
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
};

async function prefill_from_pending(
    frm,
    pendingName,
    prefillType = "textract_tables",
    shouldHeaderBePrefilled = true
) {
    // Load Pending Document with children
    const pd = await frappe.db.get_doc("Pending Document", pendingName);

    frm._pending_document = pendingName;
    frm._pending_file = pd.file;

    if (shouldHeaderBePrefilled) {
        if (!frm.doc.bill_no && pd.bill_no && frm.doctype === "Purchase Invoice") {
            await frm.set_value("bill_no", pd.bill_no);
        }

        await frm.set_value("set_posting_time", 1);
        await frm.set_value("posting_time", "07:00:00");
        if (!frm.doc.bill_date && pd.bill_date && frm.doctype === "Purchase Invoice") {
            // check if the date is not older than 30 days
            const billDate = frappe.datetime.str_to_obj(pd.bill_date);
            const today = new Date();
            const diffTime = Math.abs(today - billDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays < 30) {
                await frm.set_value("bill_date", pd.bill_date);
                await frm.set_value("posting_date", pd.bill_date);
            }
        }

        if (!frm.doc.due_date && pd.due_date) {
            await frm.set_value("due_date", pd.due_date);
        }
        if ((pd.party_type || "").toLowerCase() === "supplier" && pd.party && !frm.doc.supplier) {
            await frm.set_value("supplier", pd.party);
        } else if (
            (pd.party_type || "").toLowerCase() === "customer" &&
            pd.party &&
            !frm.doc.customer
        ) {
            await frm.set_value("customer", pd.party);
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
    const prefillRows = [];
    for (const [rowIndex, r] of rows.entries()) {
        const item_code = r.barcode && mapped[r.barcode] ? mapped[r.barcode].item_code : null;
        if (item_code) {
            prefillRows.push({
                row_index: rowIndex,
                barcode: r.barcode || null,
                quantity: r.quantity ?? null,
                price: r.price ?? null,
                total: r.total ?? null,
                title: r.title ?? null,
                extracted_row: r,
                resolution: "matched",
                matched_item: {
                    item_code: item_code,
                    item_name: mapped[r.barcode].item_name,
                    uom: mapped[r.barcode].uom,
                    stock_uom: mapped[r.barcode].stock_uom,
                },
            });
            matched++;
        } else {
            unmatched++;
            prefillRows.push({
                row_index: rowIndex,
                barcode: r.barcode || null,
                quantity: r.quantity ?? null,
                price: r.price ?? null,
                total: r.total ?? null,
                title: r.title ?? null,
                extracted_row: r,
                resolution: null,
                matched_item: null,
            });
        }
    }
    frm._prefill_rows = prefillRows;
    frm._unmatched_dialog_called = false;
    if (unmatched > 0) {
        frappe.confirm(
            matched == 0
                ? __(
                      "No exact matches found for extracted items. Do you want to review unmatched rows and try to match them manually with a help of fuzzy matching?<br><br></b> This can be especially useful if the invoice does not contain barcodes."
                  )
                : __(
                      "Successfully prefilled {0} items, but {1} rows seem to be unmatched. Do you want to review these unmatched rows or create items with a quick entry dialog?",
                      [matched, unmatched]
                  ),
            () => {
                frm._unmatched_dialog_called = true;
                invoice_helper.show_unmatched_items_dialog(frm);
            },
            () => {
                invoice_helper.apply_prefill_rows_to_items(frm);
            }
        );
    } else {
        invoice_helper.apply_prefill_rows_to_items(frm);
    }

    // Show the pending file drawer
    if (frm._pending_file && invoice_helper?.show_pending_file_drawer) {
        invoice_helper.show_pending_file_drawer(frm);
    }
}
// TODO: Consider passing everything to backend and brute forcing all barcodes until a match found, or show a pop up to ask user if they want to create items for unmatched barcodes, and in that case by user inspecting the barcode, we might found out that actually the item is in the system.
function extractBarcodeFromText(text) {
    // Look for 7, 8, 12, or 13 consecutive digits
    // Can be embedded in text like "text": "Milk 330ml 5900512300481 Poland"
    // Also handle line breaks within barcodes like "477005816 0327"
    // "43130154 5905658925109 Pak. nr. 2025-93", need to return the first match;

    // Direct matches
    let barcodeMatch = text.match(/\b(\d{12,13})\b/);
    if (barcodeMatch) {
        return barcodeMatch[1];
    }

    barcodeMatch = text.match(/\b(\d{7,8})\b/);
    if (barcodeMatch) {
        return barcodeMatch[1];
    }

    // Spaced barcodes
    const spacedRegex = /\b(\d+(?:\s+\d+)+)\b/g;
    const matches = text.match(spacedRegex);
    if (matches) {
        for (const match of matches) {
            const cleaned = match.replace(/\s+/g, "");
            if (/^\d{7,8}$/.test(cleaned) || /^\d{12,13}$/.test(cleaned)) {
                return cleaned;
            }
        }
    }

    return null;
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
                        <span style="font-weight: bold;">
					${__("Table")} ${idx + 1} (${table.rows.length} ${__("rows")}, ${table.rows[0]?.length || 0} ${__(
                        "columns"
                    )}) - ${__("Confidence")}: ${(table.confidence || 0).toFixed(1)}%
                    </span>
                        <div style="margin-top: 5px; max-height: 100px; overflow-y: auto;">
                            ${render_table_preview(table).prop("outerHTML")}
                        </div>
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

    const info = d.fields_dict.mapping_info.$wrapper;
    info.append(render_table_preview(table));
    d.show();
}

const countTextChars = (value) => {
    const text = String(value || "").trim();
    if (!text) return 0;
    const letters = text.match(/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/g) || [];
    return letters.length;
};

const getTitleColumnIndex = (table, columnMapping) => {
    let bestColIdx = null;
    let bestScore = 0;

    for (let colIdx = 0; colIdx < (table.rows[0] || []).length; colIdx++) {
        const mappedType = columnMapping[`col_${colIdx}_type`];
        // TODO: not sure about excluding columns
        if (mappedType === "quantity" || mappedType === "price") {
            continue;
        }

        let textScore = 0;
        for (let rowIdx = 0; rowIdx < table.rows.length; rowIdx++) {
            const cellText = (table.rows[rowIdx]?.[colIdx]?.text || "").trim();
            textScore += countTextChars(cellText);
        }

        if (textScore > bestScore) {
            bestScore = textScore;
            bestColIdx = colIdx;
        }
    }

    return bestColIdx;
};

function extractMappedRows(table, columnMapping) {
    const rows = [];
    let hasHeader = false;

    // double check if first row looks like a header
    const firstRowText = (table.rows[0] || [])
        .map((cell) => (cell.text || "").toLowerCase())
        .join(" ");
    if (
        /(nr|item|barcode|qty|quantity|price|amount|rate|total|kaina|kiekis|suma|barkodas|kodas)/i.test(
            firstRowText
        )
    ) {
        hasHeader = true;
    }

    const startIdx = hasHeader ? 1 : 0;

    const titleColumnIdx = getTitleColumnIndex(table, columnMapping);

    // Extract rows based on column mapping
    for (let rowIdx = startIdx; rowIdx < table.rows.length; rowIdx++) {
        const row = table.rows[rowIdx];
        const mapped = {};

        mapped.all_columns = row.map((cell) => (cell?.text || "").trim());

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

        const titleText = titleColumnIdx !== null ? (row[titleColumnIdx]?.text || "").trim() : "";
        // Only add row if it has at least one mapped field MINUS title.
        if (Object.keys(mapped).length > 0) {
            mapped.title = titleText
                ? titleText
                : (mapped.title = row.map((cell) => cell.text.trim() || "").join(" "));
            rows.push(mapped);
        }
    }

    return rows;
}

invoice_helper.attach_pending_document_file_to_form = async (frm, pendingFile) => {
    if (!frm || !pendingFile) return;

    const doctype = frm.doctype || frm.doc.doctype;
    const docname = frm.docname || frm.doc.name;

    const r = await invoice_helper.attach_pending_document_file(pendingFile, doctype, docname);
    if (r.message) {
        frm.attachments.attachment_uploaded(r.message);
        console.log("File attached successfully:", r.message);
        frappe.show_alert({
            message: __("File attached"),
            indicator: "green",
        });
    }
};

// We could use predefined frappe methods to attach files
// However, it is always "Home/Attachments" folder which is not desired
// Therefore, we make a custom implementation here
invoice_helper.attach_pending_document_file = async (pendingFile, doctype, docname) => {
    try {
        const fileDoc = await frappe.db.get_doc("File", pendingFile);

        if (fileDoc) {
            // POST /api/method/upload_file
            return new Promise((resolve, reject) => {
                frappe.call({
                    method: "frappe.handler.upload_file",
                    args: {
                        is_private: fileDoc.is_private,
                        folder: fileDoc.folder,
                        library_file_name: fileDoc.name,
                        doctype: doctype,
                        docname: docname,
                    },
                    callback: (r) => {
                        if (r.message) {
                            console.log("File attached successfully:", r.message);
                            resolve(r);
                        } else {
                            reject(new Error("No message in response"));
                        }
                    },
                    error: (r) => {
                        reject(new Error(r.message || "Unknown error"));
                    },
                });
            });
        } else {
            frappe.msgprint({
                title: __("File not found"),
                message: __("Could not find File document: {0}", [pendingFile]),
                indicator: "red",
            });
            throw new Error("File not found: " + pendingFile);
        }
    } catch (err) {
        console.error("Error attaching file:", err);
        frappe.show_alert({
            message: __("Could not attach file from Pending Document: {0}", [err.message]),
            indicator: "orange",
        });
        throw err;
    }
};
// Render a preview table (header + up to 3 data rows)
function render_table_preview(table) {
    const preview = $(
        `<table class="table table-bordered" style="font-size: 11px; max-height: 200px; overflow-y: auto;">
                <tbody></tbody>
            </table>`
    );
    if (!table || !table.rows || !table.rows.length) return preview;
    for (let rowIdx = 0; rowIdx < Math.min(4, table.rows.length); rowIdx++) {
        const row = table.rows[rowIdx];
        const tr = $("<tr>");
        for (let colIdx = 0; colIdx < row.length; colIdx++) {
            const cell = row[colIdx];
            const text = (cell.text || "").substring(0, 20);
            $("<td>" + text + "</td>").appendTo(tr);
        }
        preview.find("tbody").append(tr);
    }
    return preview;
}
invoice_helper.restore_prefilled_rates = function (frm) {
    if (!frm || !frm.doc.items) {
        frappe.show_alert({
            message: __("No items to restore"),
            indicator: "orange",
        });
        return;
    }

    let restored = 0;
    frm.doc.items.forEach((item) => {
        if (item.original_price !== undefined && item.original_price !== null) {
            if (item.rate !== item.original_price) {
                item.rate = item.original_price;
                restored++;
            }
        }
    });

    frm.refresh_field("items");

    if (restored > 0) {
        frappe.show_alert({
            message: __("Restored {0} item price(s) to original extraction value", [restored]),
            indicator: "green",
        });
    } else {
        frappe.show_alert({
            message: __("No price changes detected"),
            indicator: "blue",
        });
    }
};

invoice_helper.apply_prefill_rows_to_items = function (frm) {
    const prefillRows = Array.isArray(frm?._prefill_rows) ? frm._prefill_rows : [];

    const appendRow = async (rowData) => {
        if (!rowData?.item_code && frm._unmatched_dialog_called) return;

        const child = frm.add_child("items", {});

        if (rowData.item_code) {
            // triggers handlers
            await frappe.model.set_value(
                child.doctype,
                child.name,
                "item_code",
                rowData.item_code
            );
        } else if (rowData.item_name) {
            child.item_name = rowData.item_name;
        }
        if (rowData.uom) {
            await frappe.model.set_value(child.doctype, child.name, "uom", rowData.uom);
        }
        if (rowData.quantity !== null && rowData.quantity !== undefined) {
            await frappe.model.set_value(child.doctype, child.name, "qty", rowData.quantity);
        }
        if (rowData.price !== null && rowData.price !== undefined) {
            await frappe.model.set_value(child.doctype, child.name, "rate", rowData.price);
            // Keep a copy of the extracted price so restore_prefilled_rates()
            // can still restore it even if ERPNext recalculates `rate`.
            child.original_price = rowData.price;
        }
        if (rowData.total !== null && rowData.total !== undefined) {
            child.amount = rowData.total;
        }
    };

    const run = async () => {
        for (const row of prefillRows) {
            if (row?.matched_item?.item_code && row.resolution !== "ignored") {
                await appendRow({
                    item_code: row.matched_item.item_code,
                    uom: row.matched_item.uom || row.matched_item.stock_uom,
                    quantity: row.quantity ?? null,
                    price: row.price ?? null,
                    total: row.total ?? null,
                });
            } else if (!row?.resolution) {
                await appendRow({
                    item_code: null,
                    item_name: null,
                    quantity:
                        row.quantity ??
                        row.extracted_row?.quantity ??
                        row.extracted_row?.qty ??
                        null,
                    price:
                        row.price ?? row.extracted_row?.price ?? row.extracted_row?.rate ?? null,
                    total:
                        row.total ?? row.extracted_row?.total ?? row.extracted_row?.amount ?? null,
                });
            }
        }

        frm.refresh_field("items");

        frm._prefill_rows = [];
        frm._prefill_allow_half_empty_rows = false;
    };

    void run();
};

invoice_helper.show_unmatched_items_dialog = function (frm) {
    const prefillRows = Array.isArray(frm?._prefill_rows) ? frm._prefill_rows : [];
    frm._prefill_rows = prefillRows;

    const unmatchedRows = prefillRows.filter((row) => !row?.matched_item?.item_code);
    const pendingRows = unmatchedRows.filter((row) => !row.resolution);

    if (!pendingRows.length) {
        frappe.show_alert({
            message: __("No unmatched rows to review"),
            indicator: "blue",
        });
        return;
    }

    const escapeHtml = (value) =>
        String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");

    const normalizeBarcode = (value) => {
        const raw = String(value || "").trim();
        if (!raw) return null;

        return raw.replace(/\D/g, "");
    };

    const parseNumeric = (value) => {
        const text = String(value ?? "").trim();
        if (!text) return null;
        const normalized = text.replace(/\s/g, "").replace(/,/g, ".");
        const parsed = parseFloat(normalized);
        return Number.isNaN(parsed) ? null : parsed;
    };

    const extractTitle = (row) => {
        const source = [
            row?.title,
            row?.extracted_row?.title,
            row?.extracted_row?.item,
            row?.extracted_row?.name,
            row?.barcode,
        ]
            .map((value) => String(value || "").trim())
            .filter(Boolean);
        return source[0] || "";
    };

    const getFuzzyRecommendations = async (queryTitle) => {
        try {
            const res = await frappe.call({
                method: "invoice_helper.api.recommend_items_for_title",
                args: { title: queryTitle, max_results: 8 },
            });
            return Array.isArray(res?.message) ? res.message : [];
        } catch (err) {
            console.error("Could not load fuzzy recommendations:", err);
            return [];
        }
    };

    const getPartialBarcodeRecommendations = async (barcode) => {
        try {
            const res = await frappe.call({
                method: "invoice_helper.api.recommend_items_for_partial_barcode",
                args: { barcode: barcode, max_results: 10 },
            });
            return Array.isArray(res?.message) ? res.message : [];
        } catch (err) {
            console.error("Could not load partial barcode recommendations:", err);
            return [];
        }
    };

    const updateMatchedRowData = (row, match, barcode, quantity, price) => {
        row.matched_item = {
            item_code: match.item_code,
            item_name: match.item_name,
            uom: match.uom,
            stock_uom: match.stock_uom,
        };
        row.barcode = barcode;
        row.quantity = quantity;
        row.price = price;
        row.extracted_row = {
            ...(row.extracted_row || {}),
            barcode,
            quantity,
            price,
        };
    };

    const processUnmatchedRowAt = async (index) => {
        if (index >= pendingRows.length) {
            invoice_helper.apply_prefill_rows_to_items(frm);
            frappe.show_alert({
                message: __("Finished reviewing unmatched rows"),
                indicator: "green",
            });
            return;
        }

        const row = pendingRows[index];
        const rowNumber = row.row_index ?? index;
        const extractedJson = JSON.stringify(row.extracted_row || {}, null, 2);
        const allColumns = Array.isArray(row?.extracted_row?.all_columns)
            ? row.extracted_row.all_columns
            : [];

        const originalBarcode = normalizeBarcode(row.barcode || row.extracted_row?.barcode || "");
        let validatedMatch = null;
        let validatedBarcode = null;

        const amendDialog = new frappe.ui.Dialog({
            title: __("Unmatched Row {0} of {1}", [index + 1, pendingRows.length]),
            fields: [
                {
                    fieldname: "row_preview",
                    fieldtype: "HTML",
                    label: __("Extracted Row"),
                },
                {
                    fieldname: "barcode",
                    label: __("Barcode (Optional)"),
                    fieldtype: "Data",
                    default: row.barcode || row.extracted_row?.barcode || "",
                },
                {
                    fieldname: "recommended_html",
                    fieldtype: "HTML",
                    label: __("Recommended Items"),
                },
                {
                    fieldname: "manual_item_code",
                    label: __("Manual Item (Optional)"),
                    fieldtype: "Link",
                    options: "Item",
                    description: __("You may also try to search using item name or code."),
                },
                {
                    fieldname: "quantity",
                    label: __("Quantity"),
                    fieldtype: "Data",
                    default:
                        row.quantity ??
                        row.extracted_row?.quantity ??
                        row.extracted_row?.qty ??
                        "",
                },
                {
                    fieldname: "price",
                    label: __("Price"),
                    fieldtype: "Data",
                    default:
                        row.price ?? row.extracted_row?.price ?? row.extracted_row?.rate ?? "",
                },
                {
                    fieldname: "barcode_status",
                    fieldtype: "HTML",
                    label: __("Validation"),
                },
            ],
            primary_action_label: __("Skip"),
            primary_action: () => {
                row.resolution = "ignored";
                amendDialog.hide();
                void processUnmatchedRowAt(index + 1);
            },
            secondary_action_label: __("Create New Item"),
            secondary_action: () => {
                const barcode = normalizeBarcode(amendDialog.get_value("barcode"));
                if (!barcode) {
                    frappe.msgprint({
                        title: __("Invalid Barcode"),
                        message: __("Please provide a valid barcode before creating a new item."),
                        indicator: "orange",
                    });
                    return;
                }

                const itemName =
                    row.title || row.extracted_row?.title || row.barcode || __("New Item");
                amendDialog.hide();
                const quickEntryDoc = frappe.model.get_new_doc("Item");
                quickEntryDoc.item_name = itemName;
                frappe.ui.form.make_quick_entry(
                    "Item",
                    async (newItem) => {
                        try {
                            const createdItemName = newItem?.name || newItem?.doc?.name;
                            if (!createdItemName) {
                                throw new Error(
                                    "Created Item name missing from quick entry callback"
                                );
                            }

                            const itemDoc = await frappe.db.get_doc("Item", createdItemName);
                            const hasBarcode = (itemDoc.barcodes || []).some(
                                (barcodeRow) => (barcodeRow.barcode || "").trim() === barcode
                            );

                            if (!hasBarcode) {
                                const barcodeRow = frappe.model.add_child(
                                    itemDoc,
                                    "Item Barcode",
                                    "barcodes"
                                );
                                barcodeRow.barcode = barcode;
                                barcodeRow.uom = itemDoc.stock_uom || "Nos";

                                const docToSave = {
                                    ...itemDoc,
                                    doctype: itemDoc.doctype || "Item",
                                    name: itemDoc.name || createdItemName,
                                };

                                await frappe.call({
                                    method: "frappe.client.save",
                                    args: { doc: docToSave },
                                });
                            }
                        } catch (err) {
                            console.error("Could not append barcode on created Item:", err);
                            frappe.show_alert({
                                message: __(
                                    "Item was created, but barcode row was not added automatically."
                                ),
                                indicator: "orange",
                            });
                        }

                        row.resolution = "create_item";
                        row.created_item = newItem?.name || newItem?.doc?.name || null;
                        row.matched_item = {
                            item_code: row.created_item,
                            item_name: newItem?.item_name || itemName,
                            uom: newItem?.stock_uom || "Nos",
                            stock_uom: newItem?.stock_uom || "Nos",
                        };
                        frappe.show_alert({
                            message: __("Created Item: {0}. Continuing unmatched review.", [
                                newItem?.name || newItem?.doc?.name || itemName,
                            ]),
                            indicator: "green",
                        });
                        void processUnmatchedRowAt(index + 1);
                    },
                    null,
                    quickEntryDoc,
                    true
                );
            },
        });

        const setStatusHtml = (message, color = "#6b7280") => {
            amendDialog.fields_dict.barcode_status.$wrapper.html(
                `<div style="color: ${color}; margin-top: 4px;">${escapeHtml(message)}</div>`
            );
        };

        const getActionButtons = () => {
            const primary = amendDialog.get_primary_btn ? amendDialog.get_primary_btn() : null;
            const secondary = amendDialog.get_secondary_btn
                ? amendDialog.get_secondary_btn()
                : null;
            return {
                primary,
                secondary,
            };
        };

        const setActionsVisible = (visible) => {
            const { primary, secondary } = getActionButtons();
            const displayValue = visible ? "" : "none";

            if (primary && primary.length) {
                primary.css("display", displayValue);
            }
            if (secondary && secondary.length) {
                secondary.css("display", displayValue);
            }
        };

        const setPrimaryAsSkip = () => {
            amendDialog.set_primary_action(__("Skip"), () => {
                row.resolution = "ignored";
                amendDialog.hide();
                void processUnmatchedRowAt(index + 1);
            });
        };

        const toMatchShape = (item) => {
            if (!item?.item_code) return null;
            return {
                item_code: item.item_code,
                item_name: item.item_name || item.item_code,
                uom: item.uom || item.stock_uom || "Nos",
                stock_uom: item.stock_uom || item.uom || "Nos",
            };
        };

        const applySelection = ({
            match,
            barcode = null,
            statusMessage = null,
            statusColor = "#15803d",
        }) => {
            const normalizedMatch = toMatchShape(match);
            if (!normalizedMatch) {
                validatedMatch = null;
                validatedBarcode = null;
                setPrimaryAsSkip();
                return;
            }

            validatedMatch = normalizedMatch;
            validatedBarcode =
                barcode || normalizeBarcode(amendDialog.get_value("barcode")) || null;
            amendDialog.set_value("manual_item_code", normalizedMatch.item_code);
            setPrimaryAsContinue();

            if (statusMessage) {
                setStatusHtml(statusMessage, statusColor);
            }
        };

        const setPrimaryAsContinue = () => {
            amendDialog.set_primary_action(__("Continue"), () => {
                if (!validatedMatch) {
                    setPrimaryAsSkip();
                    setStatusHtml(
                        __(
                            "No selected item yet. Pick recommendation, set Manual Item, or verify barcode."
                        ),
                        "#b45309"
                    );
                    return;
                }

                const quantity = parseNumeric(amendDialog.get_value("quantity"));
                const price = parseNumeric(amendDialog.get_value("price"));

                updateMatchedRowData(
                    row,
                    validatedMatch,
                    validatedBarcode || normalizeBarcode(amendDialog.get_value("barcode")) || null,
                    quantity,
                    price
                );
                row.resolution = "amended";

                amendDialog.hide();
                void processUnmatchedRowAt(index + 1);
            });
        };

        const verifyChangedBarcode = async () => {
            validatedMatch = null;
            validatedBarcode = null;
            amendDialog.set_value("manual_item_code", "");
            setPrimaryAsSkip();

            const normalized = normalizeBarcode(amendDialog.get_value("barcode"));

            if (!normalized) {
                setStatusHtml(__("Barcode must contain digits."), "#dc2626");
                return;
            }

            if (normalized === originalBarcode) {
                setStatusHtml(
                    __("Barcode not changed yet. Change it to validate and enable Continue."),
                    "#b45309"
                );
                return;
            }

            setStatusHtml(__("Checking barcode..."), "#2563eb");

            try {
                const res = await frappe.call({
                    method: "invoice_helper.api.get_item_codes_for_barcodes",
                    args: { barcodes: [normalized] },
                });
                const found = res?.message?.[normalized];

                if (found?.item_code) {
                    applySelection({
                        match: found,
                        barcode: normalized,
                        statusMessage: __("Matched Item: {0} ({1}). You can Continue.", [
                            found.item_code,
                            found.item_name || "",
                        ]),
                    });
                    recommendations = [];
                    renderRecommendations();
                } else {
                    amendDialog.set_value("manual_item_code", "");
                    recommendations = await getPartialBarcodeRecommendations(normalized);
                    renderRecommendations();
                    setStatusHtml(
                        __("No Item found for this barcode. Use Skip or Create new item."),
                        "#b45309"
                    );
                }
            } catch (err) {
                console.error("Barcode verification failed:", err);
                amendDialog.set_value("manual_item_code", "");
                recommendations = [];
                renderRecommendations();
                setStatusHtml(__("Barcode check failed. Please try again."), "#dc2626");
            }
        };

        const wrapper = amendDialog.fields_dict.row_preview.$wrapper;
        const allColumnsHtml = allColumns.length
            ? `<div style="max-height: 250px; overflow: auto;">
                    <table class="table table-bordered" style="margin: 0; font-size: 12px; line-height:1;">
                        <thead>
                            <tr>
                                <th style="width: 60px;">${escapeHtml(__("Column"))}</th>
                                <th>${escapeHtml(__("Value"))}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${allColumns
                                .map(
                                    (value, idx) => `<tr>
                                        <td>${escapeHtml(String(idx + 1))}</td>
                                        <td>${escapeHtml(String(value || ""))}</td>
                                    </tr>`
                                )
                                .join("")}
                        </tbody>
                    </table>
                </div>`
            : `<pre style="max-height: 280px; overflow: auto;">${escapeHtml(extractedJson)}</pre>`;

        wrapper.html(
            `<div style="margin-bottom: 10px;"><strong>${__("Source row")}: ${escapeHtml(
                rowNumber + 1
            )}</strong></div>${allColumnsHtml}`
        );

        let recommendations = await getFuzzyRecommendations(extractTitle(row));
        const recommendedWrapper = amendDialog.fields_dict.recommended_html.$wrapper;

        const syncRecommendationSelection = (itemCode) => {
            const normalized = String(itemCode || "").trim();
            const buttons = recommendedWrapper.find(".invoice-helper-fuzzy-option");
            if (!buttons.length) return;

            buttons.removeClass("btn-primary").addClass("btn-default");
            if (!normalized) return;

            buttons.each(function () {
                const buttonCode = String($(this).data("item-code") || "").trim();
                if (buttonCode === normalized) {
                    $(this).removeClass("btn-default").addClass("btn-primary");
                }
            });
        };

        const renderRecommendations = () => {
            if (!recommendations.length) {
                recommendedWrapper.html(
                    `<div style="color: #b45309;">${escapeHtml(
                        __("No recommendations found. Use Manual Item field.")
                    )}</div>`
                );
                return;
            }

            const rowsHtml = recommendations
                .map((rec) => {
                    const title = [rec.item_name, rec.stock_uom].filter(Boolean).join(" • ");
                    const subtitle = rec.matched_barcode
                        ? __("Score {0} • Item {1} • Barcode {2}", [
                              rec.score || 0,
                              rec.item_code,
                              rec.matched_barcode,
                          ])
                        : __("Score {0} • Item {1}", [rec.score || 0, rec.item_code]);
                    return `<button type="button" class="btn btn-default invoice-helper-fuzzy-option" data-item-code="${escapeHtml(
                        rec.item_code
                    )}" style="display:block; width:100%; text-align:left; margin-bottom:6px;">
                        <div>${escapeHtml(title)}</div>
                        <div style="font-size:11px; color:#9ca3af;">${escapeHtml(subtitle)}</div>
                    </button>`;
                })
                .join("");

            recommendedWrapper.html(rowsHtml);

            recommendedWrapper.find(".invoice-helper-fuzzy-option").on("click", function () {
                const itemCode = String($(this).data("item-code") || "").trim();
                if (!itemCode) return;
                const selected = recommendations.find((rec) => rec.item_code === itemCode);
                applySelection({
                    match: selected,
                    barcode: normalizeBarcode(amendDialog.get_value("barcode")) || null,
                    statusMessage: __("Selected recommendation: {0}", [
                        selected?.item_code || itemCode,
                    ]),
                });
                syncRecommendationSelection(itemCode);
            });
        };

        renderRecommendations();

        const manualField = amendDialog.get_field("manual_item_code");
        if (manualField?.$input) {
            manualField.$input.on("change blur", async () => {
                const manualItemCode = String(
                    amendDialog.get_value("manual_item_code") || ""
                ).trim();
                if (!manualItemCode) {
                    validatedMatch = null;
                    validatedBarcode = null;
                    setPrimaryAsSkip();
                    return;
                }

                const fromRecommendations = recommendations.find(
                    (rec) => rec.item_code === manualItemCode
                );
                if (fromRecommendations) {
                    applySelection({
                        match: fromRecommendations,
                        barcode: normalizeBarcode(amendDialog.get_value("barcode")) || null,
                        statusMessage: __("Using: {0}", [manualItemCode]),
                    });
                    syncRecommendationSelection(manualItemCode);
                    return;
                }

                try {
                    const itemDoc = await frappe.db.get_doc("Item", manualItemCode);
                    applySelection({
                        match: {
                            item_code: itemDoc.name,
                            item_name: itemDoc.item_name,
                            uom: itemDoc.stock_uom,
                            stock_uom: itemDoc.stock_uom,
                        },
                        barcode: normalizeBarcode(amendDialog.get_value("barcode")) || null,
                        statusMessage: __("Selected: {0}", [itemDoc.item_name]),
                    });
                    syncRecommendationSelection(manualItemCode);
                } catch (err) {
                    console.error("Manual item lookup failed:", err);
                    setStatusHtml(__("Manual Item not found. Choose a valid Item."), "#dc2626");
                    setPrimaryAsSkip();
                    syncRecommendationSelection(null);
                }
            });
        }

        amendDialog.show();
        setStatusHtml(
            __(
                "Enter/Change barcode to validate, you may also pick a recommendation or enter item name. If matched, Skip becomes Continue."
            )
        );

        const barcodeInput = amendDialog.get_field("barcode").$input;
        if (barcodeInput) {
            let debounceTimer = null;

            barcodeInput.on("focus", () => {
                setActionsVisible(false);
                recommendedWrapper.html("");
                setStatusHtml(__("Editing barcode..."), "#6b7280");
            });

            barcodeInput.on("input", () => {
                setActionsVisible(false);
                recommendedWrapper.html("");
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                }
                debounceTimer = setTimeout(() => {
                    verifyChangedBarcode();
                }, 300);
            });

            barcodeInput.on("blur", async () => {
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                    debounceTimer = null;
                }
                await verifyChangedBarcode();
                setActionsVisible(true);
            });
        }
    };

    void processUnmatchedRowAt(0);
};

invoice_helper.show_move_file_dialog = function (pendingFile) {
    if (!pendingFile) return;

    const d = new frappe.ui.Dialog({
        title: __("Attach File to Invoice"),
        fields: [
            {
                fieldname: "invoice_type",
                label: __("Invoice Type"),
                fieldtype: "Select",
                options: [
                    { label: __("Purchase Invoice"), value: "Purchase Invoice" },
                    { label: __("Sales Invoice"), value: "Sales Invoice" },
                ],
                default: "Purchase Invoice",
                reqd: 1,
                onchange: () => {
                    const invoiceType = d.get_value("invoice_type");
                    d.fields_dict.invoice.df.options = invoiceType;
                    d.fields_dict.invoice.refresh();
                    d.set_value("invoice", "");
                },
            },
            {
                fieldname: "invoice",
                label: __("Invoice"),
                fieldtype: "Link",
                options: "Purchase Invoice",
                get_query: () => ({
                    filters: { docstatus: 0 },
                }),
                reqd: 1,
            },
        ],
        primary_action_label: __("Attach"),
        primary_action: async (values) => {
            if (!values?.invoice || !values?.invoice_type) return;
            d.hide();
            const r = await invoice_helper.attach_pending_document_file(
                pendingFile,
                values.invoice_type,
                values.invoice
            );
            if (r.message) {
                frappe.show_alert({
                    message: __("File attached successfully"),
                    indicator: "green",
                });
            }
        },
    });

    d.show();
};
