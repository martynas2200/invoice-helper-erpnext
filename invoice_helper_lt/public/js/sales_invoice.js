frappe.ui.form.on("Sales Invoice", {
  async refresh(frm) {
    if (frm.is_new()) {
      frm.add_custom_button("Prefill from Pending Document", () => prefill_from_pending_dialog_si(frm)).addClass("btn-primary");
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
            description: __("Choose a Pending Document (Type = Sale recommended)"),
          },
        ],
        primary_action_label: __("Import"),
        primary_action: (values) => {
          if (!values?.pending) return;
          frappe.call({
            method: "invoice_helper_lt.invoice_from_pending.apply_from_pending_document",
            args: { target_invoice: frm.doc.name, pending: values.pending },
            freeze: true,
            callback: () => {
              d.hide();
              frm.reload_doc();
              frappe.show_alert({ message: __("Applied Pending Document."), indicator: "green" });
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
        description: __("Type = Sale recommended"),
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
    await frm.set_value("posting_date", pd.ex_bill_date);
  }
  if (!frm.doc.due_date && pd.ex_due_date) {
    await frm.set_value("due_date", pd.ex_due_date);
  }
  if (!frm.doc.bill_no && (pd.ex_bill_no || pd.bill_no) && frm.get_field("bill_no")) {
    await frm.set_value("bill_no", pd.ex_bill_no || pd.bill_no);
  }
  if ((pd.party_type || "").toLowerCase() === "customer" && pd.party && !frm.doc.customer) {
    await frm.set_value("customer", pd.party);
  }

  const rows = Array.isArray(pd.ex_items) ? pd.ex_items : [];
  const barcodes = rows.map(r => r.barcode).filter(Boolean);
  let mapped = {};
  if (barcodes.length) {
    const res = await frappe.db.get_list("Item Barcode", {
      filters: { barcode: ["in", barcodes] },
      fields: ["barcode", "parent"],
      limit: 1000,
    });
    for (const r of res) mapped[r.barcode] = r.parent;
  }

  let matched = 0, unmatched = 0;
  for (const r of rows) {
    const item_code = r.barcode ? mapped[r.barcode] : null;
    const child = frm.add_child("items", {});
    if (item_code) {
      child.item_code = item_code;
      matched++;
    } else {
      child.description = r.barcode ? __("Barcode: {0}", [r.barcode]) : __("No barcode");
      unmatched++;
    }
    if (r.quantity) child.qty = r.quantity;
    if (r.price) child.rate = r.price;
    if (r.total) child.amount = r.total;
  }
  frm.refresh_field("items");

  frappe.show_alert({
    message: __("Prefilled items. Matched: {0}, Unmatched: {1}", [matched, unmatched]),
    indicator: matched && !unmatched ? "green" : unmatched ? "orange" : "blue",
  });
}
