frappe.ui.form.on("Pending Document", {
    refresh(frm) {
        frm.trigger("update_file_preview");
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

            if (frm.doc.status == "Extracted") {
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
                                <svg class="icon icon-xl" style="color: #c41230;" aria-hidden="true">
                                    <use class="" href="#icon-file-text"></use>
                                </svg>
								<p style="margin-top: 8px; color: #666; font-size: 12px;">${__("PDF - Click to view")}</p>
							</div>`;
                        }
                        // Fallback: link to file
                        else {
                            preview_html = `<div style="padding: 10px; text-align: center;">
                                <svg class="icon icon-xl" style="color: #999;" aria-hidden="true">
                                    <use class="" href="#icon-file"></use>
                                </svg>
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
                                <svg class="icon" style="height: 120px; width:120px; color: #999; margin-bottom: 20px;" aria-hidden="true">
                                    <use class="" href="#icon-file-text"></use>
                                </svg>

								<h4>${file.file_name || file.name}</h4>
								<p style="color: #999; margin: 20px 0;">${__("File type")}: ${file_ext.toUpperCase()}</p>
								<a href="${file.file_url}" target="_blank" class="btn btn-primary btn-lg">
                                    <svg class="icon icon-sm" aria-hidden="true">
                                        <use href="#icon-download"></use>
                                    </svg>
                                    ${__("Download File")}
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
        // Clear any existing interval on this form
        if (frm._auto_refresh_interval) {
            clearInterval(frm._auto_refresh_interval);
        }

        // Also clear any global interval in case it was left behind
        if (window.pending_document_auto_refresh_interval) {
            clearInterval(window.pending_document_auto_refresh_interval);
            window.pending_document_auto_refresh_interval = null;
        }

        const interval_id = setInterval(() => {
            frm.reload_doc();
            frm.trigger("status");
        }, 3000);

        frm._auto_refresh_interval = interval_id;
        window.pending_document_auto_refresh_interval = interval_id;
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
        frappe._pending_document = frm.doc.name;
        frappe.new_doc("Purchase Invoice", {
            supplier: frm.doc.party,
            bill_date: frm.doc.bill_date,
            posting_time: "07:00:00",
            edit_posting_date: 1,
            bill_no: frm.doc.bill_no,
            due_date: frm.doc.due_date,
        });
    },
});

// Ensure auto-refresh is stopped when navigating away from the Pending Document form
if (!window.__pending_document_router_cleanup__) {
    frappe.router.on("change", () => {
        if (window.pending_document_auto_refresh_interval) {
            clearInterval(window.pending_document_auto_refresh_interval);
            window.pending_document_auto_refresh_interval = null;
        }
    });

    window.__pending_document_router_cleanup__ = true;
}
