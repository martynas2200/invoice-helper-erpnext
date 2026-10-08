// frappe._pending_document might be set from the pending document View
// frm._pending_document and frm._pending_file are set when pre-filling from pending document to have a hook after save

frappe.ui.form.on("Purchase Invoice", {
    onload(frm) {
        // Clear pending file when a new form is loaded
        frm._pending_file = null;
        frm._pending_document = null;
    },
    async refresh(frm) {
        if (frappe._pending_document) {
            // delete the global variable to avoid re-triggering
            const pending_doc = frappe._pending_document;
            frappe._pending_document = null;
            await invoice_helper.prefill_from_pending_dialog(frm, pending_doc);
        }
        if (frm.doc.docstatus == 1 || frm.doc.docstatus == 2) {
            return;
        }
        frm.add_custom_button(
            __("Prefill from Pending Document"),
            () => invoice_helper.prefill_from_pending_dialog(frm),
            __("Invoice Helper")
        );

        frm.add_custom_button(
            __("Restore prefilled rates"),
            () => {
                invoice_helper.restore_prefilled_rates(frm);
            },
            __("Invoice Helper")
        );
    },
    on_submit(frm) {
        frm?.attachments?.hide_attachment_preview();
    },
    async after_save(frm) {
        await invoice_helper.after_save_hook(frm);
    },
});
