frappe.provide("invoice_helper");

invoice_helper.show_move_file_dialog = function (pendingDocument, pendingFile) {
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
                frappe.db.set_value("Pending Document", pendingDocument, "status", "Moved");
            }
        },
    });

    d.show();
};
