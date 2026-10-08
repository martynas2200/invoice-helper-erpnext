frappe.provide("invoice_helper");

invoice_helper.after_save_hook = async function (frm) {
    // Only proceed if there is a pending file to attach
    if (!frm || !frm._pending_file) {
        return;
    }

    // Small delay to ensure the document is fully saved and named
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Capture and clear the flag early to avoid repeated attachments
    const pending_file = frm._pending_file;
    frm._pending_file = null;

    try {
        await invoice_helper.attach_pending_document_file_to_form(frm, pending_file);

        if (frm._pending_document) {
            await frappe.db.set_value("Pending Document", frm._pending_document, "status", "Used");
        }
    } catch (err) {
        console.error("Error in invoice_helper.after_save_hook:", err);
    }
};

invoice_helper.prefill_from_pending_dialog = function (frm, pending_name = null) {
    if (!frm) return;

    if (!pending_name && frm._pending_document) {
        pending_name = frm._pending_document;
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
                default: pending_name,
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

// Preview the pending file using Frappe's built-in attachment preview pane.
async function show_pending_file_preview(frm) {
    if (!frm || !frm._pending_file || !frm.attachments) {
        return;
    }
    try {
        const file_doc = await frappe.db.get_doc("File", frm._pending_file);
        if (!file_doc || !file_doc.file_url) {
            console.warn("No file URL found for pending file:", frm._pending_file);
            return;
        }
        // Frappe hides the whole sidebar for unsaved docs, which would hide the preview too.
        frm.page.sidebar.removeClass("hide-sidebar");
        frm.attachments.setup_preview_area?.();
        frm.attachments.show_attachment_preview(file_doc, file_doc.file_url);
    } catch (err) {
        console.error("Error loading pending file:", err);
    }
}

// Records which Pending Document/File the invoice was prefilled from, so
// after_save_hook() can attach the file once the invoice is saved.
function remember_pending_source(frm, pd) {
    frm._pending_document = pd.name;
    frm._pending_file = pd.file;
}

function is_date_within_last_days(date_str, max_age_days) {
    const date = frappe.datetime.str_to_obj(date_str);
    const age_in_days = Math.ceil(Math.abs(new Date() - date) / (1000 * 60 * 60 * 24));
    return age_in_days < max_age_days;
}

// Copies Bill No, posting/due dates, and supplier from the Pending Document.
async function prefill_invoice_header_from_pending(frm, pd) {
    if (!frm.doc.bill_no && pd.bill_no) {
        await frm.set_value("bill_no", pd.bill_no);
    }

    await frm.set_value("set_posting_time", 1);
    await frm.set_value("posting_time", "07:00:00");

    // Only use the bill date if it is not older than 30 days.
    if (!frm.doc.bill_date && pd.bill_date && is_date_within_last_days(pd.bill_date, 30)) {
        await frm.set_value("bill_date", pd.bill_date);
        await frm.set_value("posting_date", pd.bill_date);
    }

    if (!frm.doc.due_date && pd.due_date) {
        await frm.set_value("due_date", pd.due_date);
    }

    if (!frm.doc.supplier && pd.party) {
        await frm.set_value("supplier", pd.party);
    }
}

// Returns the extracted item rows plus the barcodes found in them.
async function extract_prefill_source_rows(pd, prefill_type) {
    if (prefill_type === "barcodes") {
        const barcode_table = Array.isArray(pd.re_barcodes) ? pd.re_barcodes : [];
        const barcodes = barcode_table
            .map((b) => (b.barcode ? b.barcode.trim() : ""))
            .filter((b) => b.length > 0);
        return { rows: barcodes.map((barcode) => ({ barcode })), barcodes };
    }

    // "local_tables" reads locally extracted tables, otherwise Amazon Textract tables.
    const table_source = prefill_type === "local_tables" ? "local_tables" : "tables";
    const rows = await select_table_and_columns_from_textract_data(pd, table_source);
    return { rows, barcodes: rows.map((r) => r.barcode).filter(Boolean) };
}

// Maps each barcode to its Item: { [barcode]: { item_code, item_name, uom, stock_uom } }.
async function fetch_item_code_map(barcodes) {
    if (!barcodes.length) {
        return {};
    }

    try {
        const res = await frappe.call({
            method: "invoice_helper.api.get_item_codes_for_barcodes",
            args: { barcodes: barcodes },
        });
        return res.message || {};
    } catch (err) {
        console.error("Error fetching Item Barcodes:", err);
        return {};
    }
}

// Turns extracted rows into prefill rows and counts matched vs unmatched ones.
function build_prefill_rows(rows, item_code_map) {
    const prefill_rows = [];
    let matched = 0;
    let unmatched = 0;

    for (const [row_index, r] of rows.entries()) {
        const mapped_item = r.barcode ? item_code_map[r.barcode] : null;
        const is_matched = Boolean(mapped_item && mapped_item.item_code);

        prefill_rows.push({
            row_index: row_index,
            barcode: r.barcode || null,
            quantity: r.quantity ?? null,
            price: r.price ?? null,
            title: r.title ?? null,
            extracted_row: r,
            resolution: is_matched ? "matched" : null,
            matched_item: is_matched
                ? {
                      item_code: mapped_item.item_code,
                      item_name: mapped_item.item_name,
                      uom: mapped_item.uom,
                      stock_uom: mapped_item.stock_uom,
                  }
                : null,
        });

        if (is_matched) {
            matched++;
        } else {
            unmatched++;
        }
    }

    return { prefill_rows, matched, unmatched };
}

// Asks the user how to handle unmatched rows; applies the prefill directly if none.
function review_unmatched_rows_or_apply(frm, matched, unmatched) {
    if (!unmatched) {
        invoice_helper.apply_prefill_rows_to_items(frm);
        return;
    }

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
}

// Orchestrates the prefill: load the Pending Document, copy the header fields,
// extract item rows, map barcodes to Items, then apply or review the result.
async function prefill_from_pending(
    frm,
    pending_name,
    prefill_type = "textract_tables",
    should_header_be_prefilled = true
) {
    // Load Pending Document with children
    const pd = await frappe.db.get_doc("Pending Document", pending_name);

    remember_pending_source(frm, pd);

    if (should_header_be_prefilled) {
        await prefill_invoice_header_from_pending(frm, pd);
    }

    const { rows, barcodes } = await extract_prefill_source_rows(pd, prefill_type);
    const item_code_map = await fetch_item_code_map(barcodes);
    const { prefill_rows, matched, unmatched } = build_prefill_rows(rows, item_code_map);

    frm._prefill_rows = prefill_rows;
    frm._unmatched_dialog_called = false;

    review_unmatched_rows_or_apply(frm, matched, unmatched);

    // Preview the file using the built-in attachment preview pane
    if (frm._pending_file) {
        show_pending_file_preview(frm);
    }
}
function extract_barcode_from_text(text) {
    // Look for 7, 8, 12, or 13 consecutive digits
    // Can be embedded in text like "text": "Milk 330ml 5900512300481 Poland"
    // Also handle line breaks within barcodes like "477005816 0327"
    // "43130154 5905658925109 Pak. nr. 2025-93", need to return the first match;

    // Direct matches
    let barcode_match = text.match(/\b(\d{12,13})\b/);
    if (barcode_match) {
        return barcode_match[1];
    }

    barcode_match = text.match(/\b(\d{7,8})\b/);
    if (barcode_match) {
        return barcode_match[1];
    }

    // Spaced barcodes
    const spaced_regex = /\b(\d+(?:\s+\d+)+)\b/g;
    const matches = text.match(spaced_regex);
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

function normalize_column_text(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // remove diacritics
        .trim();
}

function is_numeric(value) {
    const text = String(value || "").trim();
    const number = parseFloat(text.replace(/\s/g, "").replace(",", "."));
    return !isNaN(number) && number > 0 && number < 10000 && /^[\d,.\s]+$/.test(text);
}

function score_barcode_column(values) {
    return values.reduce((score, value) => {
        const text = String(value || "").trim();
        if (extract_barcode_from_text(text)) return score + 2;
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

function score_quantity_column(values, header_text) {
    if (are_values_strictly_increasing(values)) {
        return 0;
    }
    const header = normalize_column_text(header_text);
    if (header.toLowerCase().trim() === "kiekis") {
        return 50;
    }
    let score = /(quantity|qty|kiekis)/.test(header) ? 5 : 0;
    if (/(kg|l|litre|litrais|litres)/.test(header)) {
        return score - 3;
    }
    return score + values.filter(is_numeric).length;
}

// It seem to jumped between indexes.
// hover animation are off.

function score_price_column(values, header_text) {
    if (are_values_strictly_increasing(values)) {
        return 0;
    }
    const header = normalize_column_text(header_text);
    let score = 0;

    if (/(price|rate|kaina)/.test(header)) score += 5;
    if (/(po\s+nuolaidos|po|su\s+nuolaida|after\s+discount|discounted)/.test(header)) score += 3;
    if (/(be\s+pvm|be\s+vat|excl\.?\s*vat|excluding\s+vat)/.test(header)) score += 2;

    return score + values.filter(is_numeric).length;
}

function detect_column_types(values, header_text = "") {
    return {
        barcode: { type: "barcode", score: score_barcode_column(values) },
        quantity: { type: "quantity", score: score_quantity_column(values, header_text) },
        price: { type: "price", score: score_price_column(values, header_text) },
    };
}

function compare_column_candidates(left, right) {
    if (right.candidate.score !== left.candidate.score) {
        return right.candidate.score - left.candidate.score;
    }
    return left.colIdx - right.colIdx;
}

function select_best_columns(column_detection) {
    const best_by_type = {};
    const selected_by_column = {};
    const candidates_by_type = ["barcode", "quantity", "price"].reduce((result, type) => {
        result[type] = Object.entries(column_detection)
            .map(([col_idx, detection]) => ({
                colIdx: Number(col_idx),
                candidate: detection[type],
            }))
            .filter(({ candidate }) => candidate.score > 0)
            .sort(compare_column_candidates);
        return result;
    }, {});

    // A column can only receive one mapping when generic numeric values score
    // for both quantity and price. Keep the strongest candidate, then barcode.
    for (const type of ["barcode", "quantity", "price"]) {
        for (const entry of candidates_by_type[type]) {
            const selected = selected_by_column[entry.colIdx];
            if (
                selected &&
                (selected.candidate.score > entry.candidate.score ||
                    (selected.candidate.score === entry.candidate.score &&
                        selected.type === "barcode"))
            ) {
                continue;
            }

            if (selected) delete best_by_type[selected.type];
            selected_by_column[entry.colIdx] = { type, candidate: entry.candidate };
            best_by_type[type] = entry.colIdx;
            break;
        }
    }

    return best_by_type;
}

// Extract column values from all rows for analysis
function get_column_values(rows, col_index) {
    return rows
        .slice(1) // Skip header row
        .map((row) => (row[col_index] || {}).text || "")
        .filter((v) => v.trim());
}

async function select_table_and_columns_from_textract_data(pending_doc, variable = "tables") {
    return new Promise((resolve) => {
        let tables = [];
        if (pending_doc.extraction_json) {
            try {
                const data = JSON.parse(pending_doc.extraction_json);
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
        let selected_table = tables[0];
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
                    show_column_mapping_dialog(selected_table, resolve);
                },
            });

            // Add table selection buttons
            const table_info = d.fields_dict.table_info.$wrapper;
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
                    selected_table = table;
                    d.hide();
                    show_column_mapping_dialog(selected_table, resolve);
                });
                table_info.append(button);
            });

            d.show();
            return; // Exit and wait for user selection
        }

        // Column mapping dialog
        show_column_mapping_dialog(selected_table, resolve);
    });
}

function show_column_mapping_dialog(table, resolve) {
    if (!table.rows || table.rows.length < 2) {
        frappe.show_alert({ message: __("Table has insufficient rows"), indicator: "red" });
        resolve([]);
        return;
    }

    const num_cols = table.rows[0].length;
    const fields = [
        {
            fieldname: "mapping_info",
            fieldtype: "HTML",
            label: __("Column Mapping"),
        },
    ];

    // Create column selection fields
    const column_detection = {};
    for (let col_idx = 0; col_idx < num_cols; col_idx++) {
        const column_header = (table.rows[0][col_idx] || {}).text || "";
        const values = get_column_values(table.rows, col_idx);
        column_detection[col_idx] = detect_column_types(values, column_header);
    }

    const selected_columns = select_best_columns(column_detection);

    for (let col_idx = 0; col_idx < num_cols; col_idx++) {
        const column_header = (table.rows[0][col_idx] || {}).text || "";
        const values = get_column_values(table.rows, col_idx);
        const detected_type =
            Object.entries(selected_columns).find(
                ([, selected_col_idx]) => selected_col_idx === col_idx
            )?.[0] || "";
        const header_text = `${__("Column")} ${col_idx + 1} (${column_header})`;
        fields.push({
            fieldname: `col_${col_idx}_type`,
            fieldtype: "Select",
            label: header_text,
            options: [
                { label: "-", value: "" },
                { label: __("Barcode"), value: "barcode" },
                { label: __("Quantity"), value: "quantity" },
                { label: __("Price"), value: "price" },
            ],
            default: detected_type,
            description: values.slice(0, 3).join("; "),
        });
    }

    const d = new frappe.ui.Dialog({
        title: __("Map Columns"),
        fields: fields,
        primary_action_label: __("Extract"),
        primary_action: (values) => {
            const mapped_rows = extract_mapped_rows(table, values);
            // check if there multiple `barcode`, `quantity` or `price` columns were selected
            const selected_types = Object.values(values).filter((v) => v);
            const duplicates = selected_types.filter(
                (item, index) => selected_types.indexOf(item) !== index
            );
            if (duplicates.length > 0) {
                frappe.show_alert({
                    message: __("Please ensure each column type is selected only once."),
                    indicator: "red",
                });
                return;
            }

            d.hide();
            resolve(mapped_rows);
        },
    });

    const info = d.fields_dict.mapping_info.$wrapper;
    info.append(render_table_preview(table));
    d.show();
}

const count_text_chars = (value) => {
    const text = String(value || "").trim();
    if (!text) return 0;
    const letters = text.match(/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/g) || [];
    return letters.length;
};

const get_title_column_index = (table, column_mapping) => {
    let best_col_idx = null;
    let best_score = 0;

    for (let col_idx = 0; col_idx < (table.rows[0] || []).length; col_idx++) {
        const mapped_type = column_mapping[`col_${col_idx}_type`];
        // TODO: not sure about excluding columns
        if (mapped_type === "quantity" || mapped_type === "price") {
            continue;
        }

        let text_score = 0;
        for (let row_idx = 0; row_idx < table.rows.length; row_idx++) {
            const cell_text = (table.rows[row_idx]?.[col_idx]?.text || "").trim();
            text_score += count_text_chars(cell_text);
        }

        if (text_score > best_score) {
            best_score = text_score;
            best_col_idx = col_idx;
        }
    }

    return best_col_idx;
};

function extract_mapped_rows(table, column_mapping) {
    const rows = [];

    const is_blank_row = (row) =>
        !(row || []).some((cell) => String(cell?.text || "").trim() !== "");

    const looks_like_header_row = (row) =>
        (row || [])
            .map((cell) => (cell.text || "").toLowerCase())
            .join(" ")
            .match(
                /(nr|item|barcode|qty|quantity|price|amount|rate|total|kaina|kiekis|suma|barkodas|kodas)/i
            );

    const first_non_blank_idx = table.rows.findIndex((row) => !is_blank_row(row));
    const has_header = looks_like_header_row(
        first_non_blank_idx >= 0 ? table.rows[first_non_blank_idx] : null
    );
    const start_idx = has_header ? first_non_blank_idx + 1 : 0;

    const title_column_idx = get_title_column_index(table, column_mapping);

    // Extract rows based on column mapping
    for (let row_idx = start_idx; row_idx < table.rows.length; row_idx++) {
        const row = table.rows[row_idx];
        if (is_blank_row(row)) continue;

        const mapped = {};

        mapped.all_columns = row.map((cell) => (cell?.text || "").trim());

        for (let col_idx = 0; col_idx < row.length; col_idx++) {
            const field_name = column_mapping[`col_${col_idx}_type`];
            if (field_name) {
                const cell_text = (row[col_idx]?.text || "").trim();
                let value = cell_text;

                // For barcode fields, extract barcode from text if present
                if (field_name === "barcode") {
                    const barcode = extract_barcode_from_text(cell_text);
                    value = barcode || cell_text;
                } else {
                    // For numeric fields (quantity, price), normalize numbers
                    value = cell_text.replace(/\s/g, "").replace(",", ".");
                }

                mapped[field_name] = value || cell_text;
            }
        }

        const title_text =
            title_column_idx !== null ? (row[title_column_idx]?.text || "").trim() : "";
        mapped.title =
            title_text ||
            row
                .map((cell) => (cell?.text || "").trim())
                .filter(Boolean)
                .join(" ");

        const has_mapped_value = ["barcode", "quantity", "price"].some(
            (field) => String(mapped[field] || "").trim() !== ""
        );
        if (has_mapped_value || mapped.title) {
            rows.push(mapped);
        }
    }

    return rows;
}

invoice_helper.attach_pending_document_file_to_form = async (frm, pending_file) => {
    if (!frm || !pending_file) return;

    const doctype = frm.doctype || frm.doc.doctype;
    const docname = frm.docname || frm.doc.name;

    const r = await invoice_helper.attach_pending_document_file(pending_file, doctype, docname);
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
invoice_helper.attach_pending_document_file = async (pending_file, doctype, docname) => {
    if (!pending_file || !doctype || !docname) {
        throw new Error("A source file and target document are required");
    }

    try {
        return await frappe.call({
            method: "frappe.handler.upload_file",
            args: {
                library_file_name: pending_file,
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
    for (let row_idx = 0; row_idx < Math.min(4, table.rows.length); row_idx++) {
        const row = table.rows[row_idx];
        const tr = $("<tr>");
        for (let col_idx = 0; col_idx < row.length; col_idx++) {
            const cell = row[col_idx];
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

    const empty_rows = frm.doc.items.filter((row) =>
        invoice_helper.is_untouched_empty_item_row(row)
    );

    empty_rows.forEach((row) => frappe.model.clear_doc(row.doctype, row.name));

    if (empty_rows.length) {
        frm.refresh_field("items");
        frm.dirty?.();
    }

    return empty_rows.length;
};

invoice_helper.apply_prefill_rows_to_items = async function (frm) {
    const prefill_rows = Array.isArray(frm?._prefill_rows) ? frm._prefill_rows : [];

    // A new form comes with an auto-added empty item row, we remove it
    if (prefill_rows.length) {
        invoice_helper.remove_untouched_empty_items(frm);
    }

    // Collect only the matched rows that carry an item_code for the batch fetch.
    const payload = [];
    for (const [idx, row] of prefill_rows.entries()) {
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
    const details_by_index = {};
    const errors_by_index = {};
    let fetch_failed = 0;
    if (payload.length) {
        try {
            const res = await frappe.call({
                method: "invoice_helper.api.get_item_details_for_prefill",
                args: { doc: frm.doc, rows: payload },
            });
            for (const r of res?.message || []) {
                if (r?.details) {
                    details_by_index[r.row_index] = r.details;
                } else if (r?.error) {
                    fetch_failed++;
                    errors_by_index[r.row_index] = r.error;
                    console.error(
                        `Could not fetch details for row ${r.row_index} (${r.item_code}):`,
                        r.error
                    );
                }
            }
        } catch (err) {
            fetch_failed = payload.length;
            console.error("Error fetching item details in batch:", err);
        }
    }

    if (fetch_failed > 0) {
        const error_messages = Object.entries(errors_by_index)
            .map(([row_index, error]) => `${row_index}: ${frappe.utils.escape_html(error)}`)
            .join("<br>");
        frappe.msgprint({
            title: __("Could not add item details"),
            message:
                error_messages ||
                __(
                    "Could not fetch item details for {0} row(s). You may need to re-select them.",
                    [fetch_failed]
                ),
            indicator: "orange",
        });
    }

    // Add rows in source order.
    for (const [idx, row] of prefill_rows.entries()) {
        if (row?.matched_item?.item_code && row.resolution !== "ignored") {
            if (errors_by_index[row.row_index ?? idx]) {
                continue;
            }
            const child = frm.add_child("items", {});
            const details = details_by_index[row.row_index ?? idx] || {};
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
    const prefill_rows = Array.isArray(frm?._prefill_rows) ? frm._prefill_rows : [];
    const pending_rows = prefill_rows.filter(
        (row) => !row?.matched_item?.item_code && !row.resolution
    );

    if (!pending_rows.length) {
        frappe.show_alert({ message: __("No unmatched rows to review"), indicator: "blue" });
        return;
    }

    const modal_container = document.createElement("div");
    document.body.appendChild(modal_container);

    const resolve_row = async (row, match, barcode, quantity, price, resolution = "amended") => {
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

    const create_item_for_row = (row, barcode, item_name) =>
        new Promise((resolve, reject) => {
            frappe.ui.form.make_quick_entry(
                "Item",
                async (new_item) => {
                    try {
                        const created_item_name = new_item?.name || new_item?.doc?.name;
                        if (!created_item_name)
                            throw new Error("Created Item name missing from quick entry callback");

                        const item_doc = await frappe.db.get_doc("Item", created_item_name);
                        const has_barcode = (item_doc.barcodes || []).some(
                            (barcode_row) => (barcode_row.barcode || "").trim() === barcode
                        );
                        if (!has_barcode) {
                            const barcode_row = frappe.model.add_child(
                                item_doc,
                                "Item Barcode",
                                "barcodes"
                            );
                            barcode_row.barcode = barcode;
                            barcode_row.uom = item_doc.stock_uom || "Nos";
                            await frappe.call({
                                method: "frappe.client.save",
                                args: {
                                    doc: {
                                        ...item_doc,
                                        doctype: item_doc.doctype || "Item",
                                        name: item_doc.name || created_item_name,
                                    },
                                },
                            });
                        }

                        resolve({
                            item_code: created_item_name,
                            item_name: new_item?.item_name || item_name,
                            uom: new_item?.stock_uom || "Nos",
                            stock_uom: new_item?.stock_uom || "Nos",
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
                (quick_entry) => {
                    quick_entry.set_value("item_name", item_name);
                }
            );
        });

    let vue_app;
    const cleanup = () => {
        vue_app?.unmount();
        modal_container.remove();
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
        vue_app = frappe.ui.mountUnmatchedItemsModal(modal_container, {
            isOpen: true,
            rows: pending_rows,
            resolveRow: resolve_row,
            createItemForRow: create_item_for_row,
            finish: finish,
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
                modal_container.remove();
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
