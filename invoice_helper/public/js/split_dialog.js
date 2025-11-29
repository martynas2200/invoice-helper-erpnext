/**
 * Split PDF dialog for invoice_helper
 */

frappe.provide("invoice_helper");

invoice_helper.show_split_dialog = function (frm) {
    if (!frm) return;
    if (
        (!frm.doc.file && !frm.doctype === "Pending Document") ||
        (!frm.doc.name && frm.doctype === "File")
    ) {
        frappe.msgprint(__("No file found."));
        return;
    }
    // frm.doc.file when Pending Document
    // frm.doc.name when File
    const file_name = frm.doc.file || frm.doc.name;

    let dialog = new frappe.ui.Dialog({
        title: __("Split PDF File"),
        fields: [
            {
                label: __("File"),
                fieldname: "file",
                fieldtype: "Link",
                options: "File",
                default: file_name,
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
            {
                label: __("Create Pending Documents"),
                fieldname: "create_pending_documents",
                fieldtype: "Check",
                default: 1,
                description: __(
                    "If checked, creates Pending Document records for each split PDF."
                ),
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
                    if (r.message && r.message.length > 0) {
                        dialog.hide();
                        frappe.show_alert({
                            message: __("PDF split successfully into {0} documents", [
                                r.message.length,
                            ]),
                            indicator: "green",
                        });
                        if (frm.doctype === "Pending Document") {
                            frm.set_value("status", "Split");
                            frm.save();
                        } else {
                            frappe.set_route("List", "File");
                        }
                    }

                    // Create Pending Document records
                    if (values.create_pending_documents && r.message && r.message.length > 0) {
                        r.message.forEach((file_name) => {
                            frappe.call({
                                method: "frappe.client.insert",
                                args: {
                                    doc: {
                                        doctype: "Pending Document",
                                        file: file_name,
                                        status: "Pending",
                                    },
                                },
                                callback: function (res) {
                                    if (res.message) {
                                        frappe.show_alert({
                                            message: __("Pending Document created for {0}", [
                                                file_name,
                                            ]),
                                            indicator: "blue",
                                        });
                                    }
                                },
                            });
                        });
                    }
                },
                error: function (r) {
                    frappe.msgprint({
                        title: __("Error"),
                        message: __("An error occurred"),
                        indicator: "red",
                    });
                },
            });
        },
    });

    dialog.show();
};
