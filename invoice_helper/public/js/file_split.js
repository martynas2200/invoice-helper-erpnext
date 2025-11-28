frappe.ui.form.on("File", {
    refresh(frm) {
        if (frm.doc.file_type === "PDF" || frm.doc.file_name.endsWith(".pdf")) {
            frm.add_custom_button(__("Split PDF"), function () {
                show_split_dialog(frm);
            });
        }
    },
});

function show_split_dialog(frm) {
    let dialog = new frappe.ui.Dialog({
        title: __("Split PDF File"),
        fields: [
            {
                label: __("File"),
                fieldname: "file",
                fieldtype: "Link",
                options: "File",
                default: frm.doc.name,
                read_only: 1,
            },
            {
                label: __("Page Ranges"),
                fieldname: "page_ranges",
                fieldtype: "Data",
                description: __("Enter page ranges separated by commas. Example: 1-2,3,4-5"),
                reqd: 1,
            },
            {
                label: __("Output Folder"),
                fieldname: "output_folder",
                fieldtype: "Link",
                options: "File",
                description: __("Select folder where split PDFs will be saved (optional)"),
                get_query: function () {
                    return {
                        filters: {
                            is_folder: 1,
                        },
                    };
                },
            },
        ],
        primary_action_label: __("Split PDF"),
        primary_action(values) {
            frappe.call({
                method: "invoice_helper.splitting.pdf.split_pdf_file",
                args: {
                    file_name: values.file,
                    page_ranges: values.page_ranges,
                    output_folder: values.output_folder || null,
                },
                callback: function (r) {
                    if (r.message) {
                        frappe.msgprint({
                            title: __("Success"),
                            message: __("PDF split successfully into {0} documents", [
                                r.message.length,
                            ]),
                            indicator: "green",
                        });
                        dialog.hide();
                    }
                },
                error: function (r) {
                    frappe.msgprint({
                        title: __("Error"),
                        message: r.responseText || __("An error occurred"),
                        indicator: "red",
                    });
                },
            });
        },
    });

    dialog.show();
}
