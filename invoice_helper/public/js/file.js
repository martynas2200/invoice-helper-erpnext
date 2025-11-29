frappe.ui.form.on("File", {
    refresh(frm) {
        if (frm.doc.file_type === "PDF" || frm.doc.file_name.endsWith(".pdf")) {
            frm.add_custom_button(__("Split PDF"), function () {
                invoice_helper.show_split_dialog(frm);
            });
        }
    },
});
