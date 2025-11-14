frappe.ui.form.on("Purchase Invoice", {
  async refresh(frm) {
    // Button for NEW PI: client-side prefill only
    if (frm.is_new()) {
      frm.add_custom_button("Prefill from Pending Document", () => prefill_from_pending_dialog(frm)).addClass("btn-primary");
      return;
    }

    // For existing PI: use server method to attach/apply
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
            description: __("Choose a Pending Document (ideally Type = Purchase)"),
          },
        ],
        primary_action_label: "Import",
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
      // Filter Pending Documents of Type = Purchase
      d.fields_dict.pending.get_query = () => ({ filters: { type: "Purchase" } });
      d.show();
    });
  },
});

function prefill_from_pending_dialog(frm) {
  const d = new frappe.ui.Dialog({
    title: __("Prefill from Pending Document"),
    fields: [
      {
        fieldname: "pending",
        label: __("Pending Document"),
        fieldtype: "Link",
        options: "Pending Document",
        reqd: 1,
        description: __("Type = Purchase recommended"),
      },
    ],
    primary_action_label: "Prefill",
    primary_action: async (values) => {
      if (!values?.pending) return;
	  await prefill_from_pending(frm, values.pending);
      d.hide();
    },
  });
  d.fields_dict.pending.get_query = () => ({ filters: { type: "Purchase" } });
  d.show();
}

async function prefill_from_pending(frm, pendingName) {
  // Load Pending Document with children
  const pd = await frappe.db.get_doc("Pending Document", pendingName);

  // Header fields
  if (!frm.doc.bill_no && (pd.ex_bill_no || pd.bill_no)) {
    await frm.set_value("bill_no", pd.ex_bill_no || pd.bill_no);
  }
  if (!frm.doc.posting_date && pd.ex_bill_date) {
    await frm.set_value("posting_date", pd.ex_bill_date);
  }
  if (!frm.doc.due_date && pd.ex_due_date) {
    await frm.set_value("due_date", pd.ex_due_date);
  }
  if ((pd.party_type || "").toLowerCase() === "supplier" && pd.party && !frm.doc.supplier) {
    await frm.set_value("supplier", pd.party);
  }

  // Prefill items by barcode mapping; unmatched barcodes result in empty item_code rows
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
      // Leave item_code empty as requested; keep a hint in description
      child.description = r.barcode ? __("Barcode: {0}", [r.barcode]) : __("No barcode");
      unmatched++;
    }
    if (r.quantity) child.qty = r.quantity;
    if (r.price) child.rate = r.price;
    if (r.total) child.amount = r.total; // ERPNext will recompute on save
  }
  frm.refresh_field("items");

  frappe.show_alert({
    message: __("Prefilled items. Matched: {0}, Unmatched: {1}", [matched, unmatched]),
    indicator: matched && !unmatched ? "green" : unmatched ? "orange" : "blue",
  });
}

