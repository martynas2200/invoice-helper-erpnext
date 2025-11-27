frappe.listview_settings["Pending Document"] = {
  onload(listview) {
    // Hide Add button
    if (listview.page.btn_primary) {
      listview.page.btn_primary.hide?.();
    }
    // Hide Import button
    listview.page.menu.find('span[data-label*="Import"]').closest('li').hide?.();

    // Upload File -> user uploads then fills metadata before creating Pending Document
    listview.page.add_menu_item(__("Upload File"), () => {
      const uploader = new frappe.ui.FileUploader({
        allow_multiple: 0,
        folder: "Home",
        restrictions: { allowed_file_types: [".pdf", ".jpg", ".jpeg", ".png"] },
        on_success(file_doc) {
          const file_name = file_doc?.file_name || file_doc?.name;
          if (!file_doc?.name) {
            frappe.msgprint({ message: __("Upload succeeded, but File doc reference missing."), indicator: "red" });
            return;
          }
          const base_name = (file_name || "").replace(/\.[^.]+$/, "");
          const dlg = new frappe.ui.Dialog({
            title: __("Create Pending Document"),
            fields: [
              { fieldname: "type", label: "Type", fieldtype: "Select", options: ["Purchase", "Sale", "Other"], default: "Purchase", reqd: 1 },
              { fieldname: "document_name", label: "Name", fieldtype: "Data", default: base_name },
            ],
            primary_action_label: __("Create"),
            primary_action(values) {
              frappe.call({
                method: "invoice_helper_lt.api.create_pending_from_file",
                args: {
                  file: file_doc.name,
                  type: values.type,
                  document_name: values.document_name,
                  party_type: values.party_type,
                  party: values.party,
                },
                freeze: true,
                callback: (r) => {
                  dlg.hide();
                  if (r.message?.name) {
                    frappe.set_route("Form", "Pending Document", r.message.name);
                  } else {
                    listview.refresh();
                  }
                },
                error: () => dlg.hide(),
              });
            },
          });
          dlg.show();
        },
      });
    });

    // Add File from File List -> choose existing File
    listview.page.add_menu_item(__("Add File from File List"), () => {
      const d = new frappe.ui.Dialog({
        title: __("Create Pending Document from File"),
        fields: [
          { fieldname: "file", label: "File", fieldtype: "Link", options: "File", reqd: 1 },
          { fieldname: "type", label: "Type", fieldtype: "Select", options: ["Purchase", "Sale", "Other"], default: "Purchase" },
          { fieldname: "document_name", label: "Name", fieldtype: "Data" },
        ],
        primary_action_label: __("Create"),
        primary_action(values) {
          if (!values?.file) return;
            frappe.call({
              method: "invoice_helper_lt.api.create_pending_from_file",
              args: values,
              freeze: true,
              callback: (r) => {
                d.hide();
                if (r.message?.name) {
                  frappe.set_route("Form", "Pending Document", r.message.name);
                } else {
                  listview.refresh();
                }
              },
              error: () => d.hide(),
            });
        },
      });
      d.show();
    });
  },
};
