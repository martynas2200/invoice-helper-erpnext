// TODO: NEEDS REWRITING <- follow DRY -> purchase_invoice.js
// NOTE: Not a priority right now, we get so few sale (credit) invoices

frappe.ui.form.on("-", {
    // !Sales Invoice Temporarily disabled
    async refresh(frm) {
        if (frm.is_new()) {
            frm.add_custom_button("Prefill from Pending Document", () =>
                prefill_from_pending_dialog_si(frm)
            ).addClass("btn-primary");
            return;
        }

        frm.add_custom_button("From Pending Document", () => {
            const d = new frappe.ui.Dialog({
                title: __("Import from Pending Document"),
                fields: [
                    {
                        fieldname: "pending",
                        label: __("Pending Document"),
                        fieldtype: "Link",
                        options: "Pending Document",
                        reqd: 1,
                        description: __("Choose a Pending Document (Type = Sale)"),
                    },
                ],
                primary_action_label: __("Import"),
                primary_action: (values) => {
                    if (!values?.pending) return;
                    frappe.call({
                        method: "invoice_helper.invoice_from_pending.apply_from_pending_document",
                        args: { target_invoice: frm.doc.name, pending: values.pending },
                        freeze: true,
                        callback: () => {
                            d.hide();
                            frm.reload_doc();
                            frappe.show_alert({
                                message: __("Applied Pending Document."),
                                indicator: "green",
                            });
                        },
                        error: () => d.hide(),
                    });
                },
            });
            d.fields_dict.pending.get_query = () => ({ filters: { type: "Sale" } });
            d.show();
        });
    },
});

function prefill_from_pending_dialog_si(frm) {
    const d = new frappe.ui.Dialog({
        title: __("Prefill from Pending Document"),
        fields: [
            {
                fieldname: "pending",
                label: __("Pending Document"),
                fieldtype: "Link",
                options: "Pending Document",
                reqd: 1,
                description: __("Type = Sale"),
            },
        ],
        primary_action_label: __("Prefill"),
        primary_action: async (values) => {
            if (!values?.pending) return;
            await prefill_from_pending_si(frm, values.pending);
            d.hide();
        },
    });
    d.fields_dict.pending.get_query = () => ({ filters: { type: "Sale" } });
    d.show();
}

async function prefill_from_pending_si(frm, pendingName) {
    const pd = await frappe.db.get_doc("Pending Document", pendingName);

    if (!frm.doc.posting_date && pd.ex_bill_date) {
        await frm.set_value("posting_date", pd.bill_date);
    }
    if (!frm.doc.due_date && pd.due_date) {
        await frm.set_value("due_date", pd.due_date);
    }
    if (!frm.doc.bill_no && (pd.bill_no || pd.bill_no) && frm.get_field("bill_no")) {
        await frm.set_value("bill_no", pd.bill_no || pd.bill_no);
    }
    if ((pd.party_type || "").toLowerCase() === "customer" && pd.party && !frm.doc.customer) {
        await frm.set_value("customer", pd.party);
    }
}
