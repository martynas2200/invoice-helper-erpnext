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

invoice_helper.prefill_from_pending_dialog = function (frm, pendingName = null) {
    if (!frm) return;

    if (!pendingName && frm._pending_document) {
        pendingName = frm._pending_document;
    }

    const d = new frappe.ui.Dialog({
        title: __("Prefill from Pending Document"),
        fields: [
            {
                fieldname: "docname",
                label: __("Pending Document"),
                fieldtype: "Link",
                get_query: () => ({
                    order_by: "`tabPending Document`.`id` desc",
                }),
                options: "Pending Document",
                default: pendingName,
                reqd: 1,
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
            if (!values?.docname) return;
            d.hide();
            await prefill_from_pending(
                frm,
                values.docname,
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
        if (!frm.doc.bill_no && pd.bill_no) {
            await frm.set_value("bill_no", pd.bill_no);
        }

        await frm.set_value("set_posting_time", 1);
        await frm.set_value("posting_time", "07:00:00");
        if (!frm.doc.bill_date && pd.bill_date) {
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
        if (!frm.doc.supplier && pd.party) {
            await frm.set_value("supplier", pd.party);
        }
    }

    // Prepare data based on prefill type
    let rows = [];
    let barcodes = [];

    if (prefillType === "local_tables") {
        // rows = Array.isArray(pd.items) ? pd.items : [];
        rows = await selectTableAndColumnsFromTextractData(pd, "local_tables");
        barcodes = rows.map((r) => r.barcode).filter(Boolean);
    } else if (prefillType === "barcodes") {
        const barcodeTable = Array.isArray(pd.re_barcodes) ? pd.re_barcodes : [];
        barcodes = barcodeTable
            .map((b) => (b.barcode ? b.barcode.trim() : ""))
            .filter((b) => b.length > 0);
        rows = barcodes.map((barcode) => ({ barcode }));
    } else {
        rows = await selectTableAndColumnsFromTextractData(pd);
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

function normalizeColumnText(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // remove diacritics
        .trim();
}

function isNumeric(value) {
    const text = String(value || "").trim();
    const number = parseFloat(text.replace(/\s/g, "").replace(",", "."));
    return !isNaN(number) && number > 0 && number < 10000 && /^[\d,.\s]+$/.test(text);
}

function scoreBarcodeColumn(values) {
    return values.reduce((score, value) => {
        const text = String(value || "").trim();
        if (extractBarcodeFromText(text)) return score + 2;
        return /^\d+$/.test(text) && text.length >= 5 ? score + 1 : score;
    }, 0);
}

function are_values_strictly_increasing(values) {
    for (let i = 1; i < values.length; i++) {
        if (values[i] <= values[i - 1]) {
            return false;
        }
    }
    return true;
}

function scoreQuantityColumn(values, headerText) {
    if (are_values_strictly_increasing(values)) {
        return 0;
    }
    const header = normalizeColumnText(headerText);
    let score = /(quantity|qty|kiekis)/.test(header) ? 5 : 0;
    if (/(kg|l|litre|litrais|litres)/.test(header)) {
        return score - 3;
    }
    return score + values.filter(isNumeric).length;
}

function scorePriceColumn(values, headerText) {
    if (are_values_strictly_increasing(values)) {
        return 0;
    }
    const header = normalizeColumnText(headerText);
    let score = 0;

    if (/(price|rate|kaina)/.test(header)) score += 5;
    if (/(po\s+nuolaidos|po|su\s+nuolaida|after\s+discount|discounted)/.test(header)) score += 3;
    if (/(be\s+pvm|be\s+vat|excl\.?\s*vat|excluding\s+vat)/.test(header)) score += 2;

    return score + values.filter(isNumeric).length;
}

function detectColumnTypes(values, headerText = "") {
    return {
        barcode: { type: "barcode", score: scoreBarcodeColumn(values) },
        quantity: { type: "quantity", score: scoreQuantityColumn(values, headerText) },
        price: { type: "price", score: scorePriceColumn(values, headerText) },
    };
}

function compareColumnCandidates(left, right) {
    if (right.candidate.score !== left.candidate.score) {
        return right.candidate.score - left.candidate.score;
    }
    return left.colIdx - right.colIdx;
}

function selectBestColumns(columnDetection) {
    const bestByType = {};
    const selectedByColumn = {};
    const candidatesByType = ["barcode", "quantity", "price"].reduce((result, type) => {
        result[type] = Object.entries(columnDetection)
            .map(([colIdx, detection]) => ({
                colIdx: Number(colIdx),
                candidate: detection[type],
            }))
            .filter(({ candidate }) => candidate.score > 0)
            .sort(compareColumnCandidates);
        return result;
    }, {});

    // A column can only receive one mapping when generic numeric values score
    // for both quantity and price. Keep the strongest candidate, then barcode.
    for (const type of ["barcode", "quantity", "price"]) {
        for (const entry of candidatesByType[type]) {
            const selected = selectedByColumn[entry.colIdx];
            if (
                selected &&
                (selected.candidate.score > entry.candidate.score ||
                    (selected.candidate.score === entry.candidate.score &&
                        selected.type === "barcode"))
            ) {
                continue;
            }

            if (selected) delete bestByType[selected.type];
            selectedByColumn[entry.colIdx] = { type, candidate: entry.candidate };
            bestByType[type] = entry.colIdx;
            break;
        }
    }

    return bestByType;
}

// Extract column values from all rows for analysis
function getColumnValues(rows, colIndex) {
    return rows
        .slice(1) // Skip header row
        .map((row) => (row[colIndex] || {}).text || "")
        .filter((v) => v.trim());
}

async function selectTableAndColumnsFromTextractData(pendingDoc, variable = "tables") {
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
        columnDetection[colIdx] = detectColumnTypes(values, columnHeader);
    }

    const selectedColumns = selectBestColumns(columnDetection);

    for (let colIdx = 0; colIdx < numCols; colIdx++) {
        const columnHeader = (table.rows[0][colIdx] || {}).text || "";
        const values = getColumnValues(table.rows, colIdx);
        const detectedType =
            Object.entries(selectedColumns).find(
                ([, selectedColIdx]) => selectedColIdx === colIdx
            )?.[0] || "";
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
            default: detectedType,
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

    const isBlankRow = (row) =>
        !(row || []).some((cell) => String(cell?.text || "").trim() !== "");

    const looksLikeHeaderRow = (row) =>
        (row || [])
            .map((cell) => (cell.text || "").toLowerCase())
            .join(" ")
            .match(
                /(nr|item|barcode|qty|quantity|price|amount|rate|total|kaina|kiekis|suma|barkodas|kodas)/i
            );

    const firstNonBlankIdx = table.rows.findIndex((row) => !isBlankRow(row));
    const hasHeader = looksLikeHeaderRow(
        firstNonBlankIdx >= 0 ? table.rows[firstNonBlankIdx] : null
    );
    const startIdx = hasHeader ? firstNonBlankIdx + 1 : 0;

    const titleColumnIdx = getTitleColumnIndex(table, columnMapping);

    // Extract rows based on column mapping
    for (let rowIdx = startIdx; rowIdx < table.rows.length; rowIdx++) {
        const row = table.rows[rowIdx];
        if (isBlankRow(row)) continue;

        const mapped = {};

        mapped.all_columns = row.map((cell) => (cell?.text || "").trim());

        for (let colIdx = 0; colIdx < row.length; colIdx++) {
            const fieldName = columnMapping[`col_${colIdx}_type`];
            if (fieldName) {
                const cellText = (row[colIdx]?.text || "").trim();
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
        mapped.title =
            titleText ||
            row
                .map((cell) => (cell?.text || "").trim())
                .filter(Boolean)
                .join(" ");

        const hasMappedValue = ["barcode", "quantity", "price"].some(
            (field) => String(mapped[field] || "").trim() !== ""
        );
        if (hasMappedValue || mapped.title) {
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
        frappe.show_alert({
            message: __("File attached"),
            indicator: "green",
        });
    }
};

// We could use predefined frappe methods to attach files
// However, it is always "Home/Attachments" folder which is not desired
invoice_helper.attach_pending_document_file = async (pendingFile, doctype, docname) => {
    if (!pendingFile || !doctype || !docname) {
        throw new Error("A source file and target document are required");
    }

    try {
        return await frappe.call({
            method: "frappe.handler.upload_file",
            args: {
                library_file_name: pendingFile,
                doctype: doctype,
                docname: docname,
            },
        });
    } catch (err) {
        console.error("Error attaching file:", err);
        frappe.show_alert({
            message: __("Could not attach file from Pending Document: {0}", [
                err.message || __("Unknown error"),
            ]),
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

invoice_helper.is_untouched_empty_item_row = function (row) {
    if (!row) return false;
    if (row.item_code) return false;
    if (row.item_name) return false;
    const qty = parseFloat(row.qty) || 0;
    const rate = parseFloat(row.rate) || 0;
    const amount = parseFloat(row.amount) || 0;
    return qty === 0 && rate === 0 && amount === 0;
};

invoice_helper.remove_untouched_empty_items = function (frm) {
    if (!frm || !Array.isArray(frm.doc?.items)) return 0;

    const emptyRows = frm.doc.items.filter((row) =>
        invoice_helper.is_untouched_empty_item_row(row)
    );

    emptyRows.forEach((row) => frappe.model.clear_doc(row.doctype, row.name));

    if (emptyRows.length) {
        frm.refresh_field("items");
        frm.dirty?.();
    }

    return emptyRows.length;
};

invoice_helper.apply_prefill_rows_to_items = async function (frm) {
    const prefillRows = Array.isArray(frm?._prefill_rows) ? frm._prefill_rows : [];

    // A new form comes with an auto-added empty item row, we remove it
    if (prefillRows.length) {
        invoice_helper.remove_untouched_empty_items(frm);
    }

    // Collect only the matched rows that carry an item_code for the batch fetch.
    const payload = [];
    for (const [idx, row] of prefillRows.entries()) {
        if (row?.matched_item?.item_code && row.resolution !== "ignored") {
            payload.push({
                row_index: row.row_index ?? idx,
                item_code: row.matched_item.item_code,
                uom: row.matched_item.uom || row.matched_item.stock_uom || null,
                qty: row.quantity ?? null,
                rate: row.price ?? null,
            });
        }
    }

    // Fetch all item details in a single API call instead of handlers calling 5 times for each item_code
    const detailsByIndex = {};
    const errorsByIndex = {};
    let fetchFailed = 0;
    if (payload.length) {
        try {
            const res = await frappe.call({
                method: "invoice_helper.api.get_item_details_for_prefill",
                args: { doc: frm.doc, rows: payload },
            });
            for (const r of res?.message || []) {
                if (r?.details) {
                    detailsByIndex[r.row_index] = r.details;
                } else if (r?.error) {
                    fetchFailed++;
                    errorsByIndex[r.row_index] = r.error;
                    console.error(
                        `Could not fetch details for row ${r.row_index} (${r.item_code}):`,
                        r.error
                    );
                }
            }
        } catch (err) {
            fetchFailed = payload.length;
            console.error("Error fetching item details in batch:", err);
        }
    }

    if (fetchFailed > 0) {
        const errorMessages = Object.entries(errorsByIndex)
            .map(([rowIndex, error]) => `${rowIndex}: ${frappe.utils.escape_html(error)}`)
            .join("<br>");
        frappe.msgprint({
            title: __("Could not add item details"),
            message:
                errorMessages ||
                __(
                    "Could not fetch item details for {0} row(s). You may need to re-select them.",
                    [fetchFailed]
                ),
            indicator: "orange",
        });
    }

    // Add rows in source order.
    for (const [idx, row] of prefillRows.entries()) {
        if (row?.matched_item?.item_code && row.resolution !== "ignored") {
            if (errorsByIndex[row.row_index ?? idx]) {
                continue;
            }
            const child = frm.add_child("items", {});
            const details = detailsByIndex[row.row_index ?? idx] || {};
            Object.assign(child, details);

            if (row.quantity !== null && row.quantity !== undefined) {
                child.qty = row.quantity;
            }
            if (row.price !== null && row.price !== undefined) {
                child.rate = row.price;
                // Keep a copy of the extracted price so restore_prefilled_rates()
                // can still restore it even if ERPNext recalculates `rate`.
                child.original_price = row.price;
            }
        } else if (!row?.resolution && !frm._unmatched_dialog_called) {
            const title = row.title || row.extracted_row?.title || null;
            const qty =
                row.quantity ?? row.extracted_row?.quantity ?? row.extracted_row?.qty ?? null;
            const rate = row.price ?? row.extracted_row?.price ?? row.extracted_row?.rate ?? null;

            // Skip rows that carry nothing usable — prevents blank item rows.
            if (!title && !qty && !rate) continue;

            const child = frm.add_child("items", {});
            if (title) child.item_name = title;
            if (qty !== null && qty !== undefined) child.qty = qty;
            if (rate !== null && rate !== undefined) child.rate = rate;
        }
    }

    frm.refresh_field("items");
    for (const item of frm.doc.items || []) {
        if (item.item_tax_rate) {
            frm.cscript.add_taxes_from_item_tax_template(item.item_tax_rate);
        }
    }

    try {
        await frm.trigger("calculate_taxes_and_totals");
        await frm.trigger("calculate_net_weight");
    } catch (err) {
        console.error("Error recalculating totals after prefill:", err);
    }

    frm._prefill_rows = [];
    frm._prefill_allow_half_empty_rows = false;
};

invoice_helper.show_unmatched_items_dialog = function (frm) {
    const prefillRows = Array.isArray(frm?._prefill_rows) ? frm._prefill_rows : [];
    const pendingRows = prefillRows.filter(
        (row) => !row?.matched_item?.item_code && !row.resolution
    );

    if (!pendingRows.length) {
        frappe.show_alert({ message: __("No unmatched rows to review"), indicator: "blue" });
        return;
    }

    const modalContainer = document.createElement("div");
    document.body.appendChild(modalContainer);

    const resolveRow = async (row, match, barcode, quantity, price, resolution = "amended") => {
        row.matched_item = {
            item_code: match.item_code,
            item_name: match.item_name || match.item_code,
            uom: match.uom || match.stock_uom || "Nos",
            stock_uom: match.stock_uom || match.uom || "Nos",
        };
        row.barcode = barcode;
        row.quantity = quantity;
        row.price = price;
        row.resolution = resolution;
        row.extracted_row = { ...(row.extracted_row || {}), barcode, quantity, price };
    };

    const createItemForRow = (row, barcode, itemName) =>
        new Promise((resolve, reject) => {
            frappe.ui.form.make_quick_entry(
                "Item",
                async (newItem) => {
                    try {
                        const createdItemName = newItem?.name || newItem?.doc?.name;
                        if (!createdItemName)
                            throw new Error("Created Item name missing from quick entry callback");

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
                            await frappe.call({
                                method: "frappe.client.save",
                                args: {
                                    doc: {
                                        ...itemDoc,
                                        doctype: itemDoc.doctype || "Item",
                                        name: itemDoc.name || createdItemName,
                                    },
                                },
                            });
                        }

                        resolve({
                            item_code: createdItemName,
                            item_name: newItem?.item_name || itemName,
                            uom: newItem?.stock_uom || "Nos",
                            stock_uom: newItem?.stock_uom || "Nos",
                        });
                    } catch (error) {
                        console.error("Could not append barcode on created Item:", error);
                        frappe.show_alert({
                            message: __(
                                "Item was created, but barcode row was not added automatically."
                            ),
                            indicator: "orange",
                        });
                        reject(error);
                    }
                },
                (quickEntry) => {
                    quickEntry.set_value("item_name", itemName);
                }
            );
        });

    let vueApp;
    const cleanup = () => {
        vueApp?.unmount();
        modalContainer.remove();
    };

    const finish = () => {
        cleanup();
        void invoice_helper.apply_prefill_rows_to_items(frm);
        frappe.show_alert({
            message: __("Finished reviewing unmatched rows"),
            indicator: "green",
        });
    };

    const mount = () => {
        if (!frappe.ui.mountUnmatchedItemsModal) {
            throw new Error("Unmatched items modal bundle did not register its Vue component");
        }
        vueApp = frappe.ui.mountUnmatchedItemsModal(modalContainer, {
            isOpen: true,
            rows: pendingRows,
            resolveRow,
            createItemForRow,
            finish,
        });
    };

    if (frappe.ui.mountUnmatchedItemsModal) {
        console.log("Mounting unmatched items modal directly");
        mount();
    } else {
        frappe
            .require("unmatched_items_modal.bundle.js")
            .then(() => {
                mount();
            })
            .catch((error) => {
                console.error("Failed to load unmatched items modal:", error);
                modalContainer.remove();
                frappe.msgprint({
                    title: __("Could not open unmatched items"),
                    message: __(
                        "The unmatched item modal could not be loaded. Please reload the page and try again."
                    ),
                    indicator: "red",
                });
            });
    }
};

invoice_helper.show_move_file_dialog = function (pendingFile) {
    if (!pendingFile) return;

    const d = new frappe.ui.Dialog({
        title: __("Attach File to Invoice"),
        fields: [
            {
                fieldname: "doctype",
                label: __("Document Type"),
                fieldtype: "Link",
                options: "DocType",
                default: "Purchase Invoice",
                reqd: 1,
                onchange: () => {
                    const doctype = d.get_value("doctype");
                    d.fields_dict.docname.df.options = doctype;
                    d.fields_dict.docname.refresh();
                    d.set_value("docname", "");
                },
            },
            {
                fieldname: "docname",
                label: __("Document Name"),
                fieldtype: "Link",
                options: "Purchase Invoice",
                reqd: 1,
            },
        ],
        primary_action_label: __("Attach"),
        primary_action: async (values) => {
            if (!values?.docname || !values?.doctype) return;
            d.hide();
            const r = await invoice_helper.attach_pending_document_file(
                pendingFile,
                values.doctype,
                values.docname
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
