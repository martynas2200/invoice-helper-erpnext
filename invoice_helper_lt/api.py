import frappe


@frappe.whitelist(methods=["POST"], allow_guest=False)
def upload_pending_document(
    type:str | None = None,
    is_private: int = 1,
    document_name:str | None = None,
    party_type:str | None = None,
    party:str | None = None,
    bill_no:str | None = None,
) -> dict:
    """Upload a file and create a linked Pending Document.

    Request should be multipart/form-data with a 'file' field. Optional 'type' is one of
    Purchase, Sale, Other.
    """
    uploaded = getattr(frappe.request, "files", {}).get("file")  # type: ignore[attr-defined]
    if not uploaded:
        frappe.throw("No file provided. Send multipart/form-data with field 'file'.")

    file_name = getattr(uploaded, "filename", None) or frappe.form_dict.get("file_name")
    content = uploaded.read() if hasattr(uploaded, "read") else uploaded.stream.read()
    if not content:
        frappe.throw("Uploaded file is empty")

    file_doc = frappe.get_doc(
        {
            "doctype": "File",
            "file_name": file_name,
            "is_private": 1 if int(is_private or 1) else 0,
            "content": content,
            "folder": "Home",
        }
    ).insert(ignore_permissions=True)

    pending = frappe.get_doc(
        {
            "doctype": "Pending Document",
            "file": file_doc.name,
            "type": (type or "Other").title(),
            "status": "Pending",
            "document_name": document_name,
            "party_type": party_type,
            "party": party,
            "bill_no": bill_no,
        }
    ).insert(ignore_permissions=True)

    return {
        "name": pending.name,
        "file_url": file_doc.file_url,
        "file_name": file_doc.file_name,
        "status": pending.status,
        "type": pending.type,
        "document_name": pending.get("document_name"),
        "party_type": pending.get("party_type"),
        "party": pending.get("party"),
        "bill_no": pending.get("bill_no"),
    }


@frappe.whitelist()
def create_pending_from_file(
    file:str | None = None,
    file_url:str | None = None,
    type:str | None = None,
    document_name:str | None = None,
    party_type:str | None = None,
    party:str | None = None,
    bill_no:str | None = None,
) -> dict:
    """Create a Pending Document from an existing File document or file_url.

    Args can be provided either 'file' (File.name) or 'file_url'.
    """
    file_doc = None
    if file:
        file_doc = frappe.get_doc("File", file)
    elif file_url:
        file_doc = frappe.get_all("File", filters={"file_url": file_url}, fields=["name"], limit=1)
        if not file_doc:
            frappe.throw("File with given file_url not found")
        file_doc = frappe.get_doc("File", file_doc[0].name)
    else:
        frappe.throw("Please specify either 'file' or 'file_url'")

    pending = frappe.get_doc(
        {
            "doctype": "Pending Document",
            "file": file_doc.name,
            "type": (type or "Other").title(),
            "status": "Pending",
            "document_name": document_name,
            "party_type": party_type,
            "party": party,
            "bill_no": bill_no,
        }
    ).insert()

    return {"name": pending.name}
