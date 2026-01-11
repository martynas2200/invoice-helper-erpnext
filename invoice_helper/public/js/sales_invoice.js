frappe.ui.form.on("Sales Invoice", {
    async refresh(frm) {
        if (frappe._pending_document) {
            // delete the global variable to avoid re-triggering
            const pendingDoc = frappe._pending_document;
            frappe._pending_document = null;
            await invoice_helper.prefill_from_pending_dialog(frm, "Sale", pendingDoc);
            // remove css rules for btn-secondary-dark
            return;
        }
        if (frm.doc.docstatus == 1 || frm.doc.docstatus == 2) {
            return;
        }
        if (frm.is_new()) {
            frm.add_custom_button("Prefill from Pending Document", () =>
                invoice_helper.prefill_from_pending_dialog(frm, "Sale")
            );
        }

        if (frm._pending_file && invoice_helper?.show_pending_file_drawer) {
            invoice_helper.show_pending_file_drawer(frm);
        }
    },
    async after_save(frm) {
        await invoice_helper.after_save_hook(frm);
    },
    on_submit(frm) {
        if (invoice_helper?.hide_pending_file_drawer) {
            invoice_helper.hide_pending_file_drawer(frm);
        }
    },
});
