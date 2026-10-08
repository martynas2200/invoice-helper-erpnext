frappe.provide("invoice_helper");

invoice_helper.show_move_file_dialog = function (pending_document, pending_file) {
    if (!pending_file) return;

    const d = new frappe.ui.Dialog({
        title: __("Attach File to Document"),
        fields: [
            {
                fieldname: "document_type",
                label: __("Document Type"),
                fieldtype: "Link",
                options: "DocType",
                default: "Purchase Invoice",
                reqd: 1,
                onchange: () => {
                    const document_type = d.get_value("document_type");
                    d.fields_dict.document.df.options = document_type;
                    d.fields_dict.document.refresh();
                    d.set_value("document", "");
                },
            },
            {
                fieldname: "document",
                label: __("Document"),
                fieldtype: "Link",
                options: "Purchase Invoice",
                reqd: 1,
            },
        ],
        primary_action_label: __("Attach"),
        primary_action: async (values) => {
            if (!values?.document || !values?.document_type) return;
            d.hide();
            const attachment = await invoice_helper.attach_pending_document_file(
                pending_file,
                values.document_type,
                values.document
            );
            if (attachment) {
                frappe.show_alert({
                    message: __("File attached successfully"),
                    indicator: "green",
                });
                frappe.db.set_value("Pending Document", pending_document, "status", "Moved");
            }
        },
    });

    d.show();
};
