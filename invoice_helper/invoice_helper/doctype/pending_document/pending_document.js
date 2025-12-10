frappe.ui.form.on("Pending Document", {
    refresh(frm) {
        frm.trigger("update_file_preview");
        frm.trigger("toggle_party_field");
        // Ensure party_type is set based on type when form loads
        frm.add_custom_button(
            __("Preview File"),
            function () {
                frm.trigger("open_file_preview_modal");
            },
            __("File")
        );
        frm.add_custom_button(
            __("Open File"),
            function () {
                frm.trigger("open_file_in_new_tab");
            },
            __("File")
        );
        frm.add_custom_button(
            __("Move"),
            function () {
                frm.trigger("move_file");
            },
            __("File")
        );
        if (!frm.doc.__islocal) {
            frm.add_custom_button(__("Split PDF"), function () {
                invoice_helper.show_split_dialog(frm);
            });

            if (
                (frm.doc.type === "Purchase" || frm.doc.type === "Sale") &&
                frm.doc.status == "Extracted"
            ) {
                frm.add_custom_button(__("Create Record"), function () {
                    frm.trigger("open_new_invoice");
                })
                    .removeClass("btn-default")
                    .addClass("btn-secondary-dark");
            }
        }
        // Auto-refresh if user waits on the page
        if (frm.doc.status === "Processing" || frm.doc.status === "Pending") {
            frm.trigger("setup_auto_refresh");
        }
    },

    file(frm) {
        frm.trigger("update_file_preview");
    },

    type(frm) {
        // Auto-set party_type based on document type
        if (frm.doc.type === "Purchase") {
            frm.set_value("party_type", "Supplier");
        } else if (frm.doc.type === "Sale") {
            frm.set_value("party_type", "Customer");
        } else {
            // Internal or Other - clear party_type
            frm.set_value("party_type", "");
            frm.set_value("party", "");
        }
        frm.trigger("toggle_party_field");
    },

    party_type(frm) {
        frm.trigger("toggle_party_field");
    },

    toggle_party_field(frm) {
        // Hide party field if party_type is empty
        frm.set_df_property("party", "hidden", !frm.doc.party_type);
    },

    update_file_preview(frm) {
        const preview_field = frm.get_field("file_preview");

        if (!frm.doc.file || !preview_field) {
            if (preview_field) {
                preview_field.html("");
            }
            return;
        }

        frappe.call({
            method: "frappe.client.get",
            args: {
                doctype: "File",
                name: frm.doc.file,
            },
            callback: function (r) {
                if (r.message && preview_field) {
                    const file = r.message;
                    let preview_html = "";

                    // Check file type and create appropriate preview
                    if (file.file_url) {
                        const file_ext = file.file_url.split(".").pop().toLowerCase();

                        // Image preview
                        if (["jpg", "jpeg", "png", "gif", "webp"].includes(file_ext)) {
                            preview_html = `<div style="text-align: center; padding: 10px; cursor: pointer;" data-file-preview="true">
								<img src="${
                                    file.file_url
                                }" style="max-width: 100%; max-height: 200px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
								<p style="margin-top: 8px; color: #666; font-size: 12px;">${__("Click to expand")}</p>
							</div>`;
                        }
                        // PDF preview (thumbnail/button)
                        else if (file_ext === "pdf") {
                            preview_html = `<div style="padding: 10px; text-align: center; cursor: pointer;" data-file-preview="true">
								<i class="fa fa-file-pdf-o" style="font-size: 48px; color: #c41230;"></i>
								<p style="margin-top: 8px; color: #666; font-size: 12px;">${__("PDF - Click to view")}</p>
							</div>`;
                        }
                        // Fallback: link to file
                        else {
                            preview_html = `<div style="padding: 10px; text-align: center;">
								<i class="fa fa-file-o" style="font-size: 48px; color: #999;"></i>
								<p style="margin-top: 8px; color: #666; font-size: 12px;">
									${file_ext.toUpperCase()}
								</p>
								<a href="${file.file_url}" target="_blank" class="btn btn-default btn-sm">${__("Open")}</a>
							</div>`;
                        }

                        preview_field.html(preview_html);

                        // Attach click handler to preview
                        preview_field.$wrapper
                            .find('[data-file-preview="true"]')
                            .on("click", function () {
                                frm.trigger("open_file_preview_modal");
                            });
                    }
                }
            },
        });
    },

    open_file_preview_modal(frm) {
        if (!frm.doc.file) {
            frappe.msgprint(__("Please select a file first"));
            return;
        }

        frappe.call({
            method: "frappe.client.get",
            args: {
                doctype: "File",
                name: frm.doc.file,
            },
            callback: function (r) {
                if (r.message) {
                    const file = r.message;

                    if (file.file_url) {
                        const file_ext = file.file_url.split(".").pop().toLowerCase();
                        let modal_content = "";

                        // Image preview
                        if (["jpg", "jpeg", "png", "gif", "webp"].includes(file_ext)) {
                            modal_content = `<div style="text-align: center; padding: 20px;">
								<img src="${file.file_url}" style="max-width: 100%; max-height: 90vh; border-radius: 4px;">
							</div>`;
                        }
                        // PDF preview
                        else if (file_ext === "pdf") {
                            modal_content = `<iframe src="${file.file_url}" type="application/pdf" width="100%" height="100%" style="border: none; height: 85vh;"></iframe>`;
                        }
                        // Fallback
                        else {
                            modal_content = `<div style="padding: 40px; text-align: center;">
								<i class="fa fa-file-o" style="font-size: 120px; color: #999; margin-bottom: 20px;"></i>
								<h4>${file.file_name || file.name}</h4>
								<p style="color: #999; margin: 20px 0;">${__("File type")}: ${file_ext.toUpperCase()}</p>
								<a href="${file.file_url}" target="_blank" class="btn btn-primary btn-lg">
									<i class="icon icon-download"></i> ${__("Download File")}
								</a>
							</div>`;
                        }

                        const d = new frappe.ui.Dialog({
                            title: file.file_name || file.name,
                            fields: [],
                            primary_action: null,
                            secondary_action: null,
                        });

                        d.$body.html(modal_content);
                        d.$wrapper.find(".modal-dialog").css("max-width", "95vw");
                        d.$wrapper
                            .find(".modal-body")
                            .css("max-height", "90vh")
                            .css("overflow", "auto");
                        d.show();
                    }
                }
            },
        });
    },

    open_file_in_new_tab(frm) {
        if (!frm.doc.file) {
            frappe.msgprint(__("Please select a file first"));
            return;
        }

        frappe.call({
            method: "frappe.client.get",
            args: {
                doctype: "File",
                name: frm.doc.file,
            },
            callback: function (r) {
                if (r.message && r.message.file_url) {
                    window.open(r.message.file_url, "_blank");
                }
            },
        });
    },

    move_file(frm) {
        if (!frm.doc.file) {
            frappe.msgprint(__("Please select a file first"));
            return;
        }
        invoice_helper.show_move_file_dialog(frm.doc.name, frm.doc.file);
    },

    setup_auto_refresh(frm) {
        if (frm._auto_refresh_interval) {
            clearInterval(frm._auto_refresh_interval);
        }

        frm._auto_refresh_interval = setInterval(() => {
            frm.reload_doc();
            frm.trigger("status");
        }, 3000);
    },

    status(frm) {
        // Start auto-refresh when status changes to Processing
        if (frm.doc.status === "Processing" || frm.doc.status === "Pending") {
            frm.trigger("setup_auto_refresh");
        } else {
            // Stop auto-refresh for other statuses
            if (frm._auto_refresh_interval) {
                clearInterval(frm._auto_refresh_interval);
                frm._auto_refresh_interval = null;
            }
        }
    },

    open_new_invoice(frm) {
        const invoice_type = frm.doc.type === "Purchase" ? "Purchase Invoice" : "Sales Invoice";
        const party_field = frm.doc.type === "Purchase" ? "supplier" : "customer";
        // let route = `/app/${doctype_route}/new`;
        // Open the new invoice form
        frappe._pending_document = frm.doc.name;
        frappe.new_doc(invoice_type, {
            [party_field]: frm.doc.party,
            bill_date: frm.doc.bill_date,
            posting_time: "07:00:00",
            edit_posting_date: 1,
            bill_no: frm.doc.bill_no,
            due_date: frm.doc.due_date,
        });
    },
});
