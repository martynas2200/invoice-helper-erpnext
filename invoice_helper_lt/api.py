import frappe
from datetime import datetime


def get_or_create_folder(folder_path: str) -> str:
    """Get or create a folder by path.

    Args:
        folder_path: Path like "Home/2025/November" or "Home/2025/11"

    Returns:
        The folder name (path)
    """
    parts = folder_path.split('/')
    current_path = ""

    for part in parts:
        if not part:
            continue

        if current_path:
            current_path += "/" + part
        else:
            current_path = part

        # Check if folder exists
        existing = frappe.get_all(
            "File",
            filters={
                "file_name": current_path,
                "is_folder": 1
            },
            limit=1
        )

        if not existing:
            # Create folder
            folder_doc = frappe.get_doc({
                "doctype": "File",
                "file_name": current_path,
                "is_folder": 1,
                "folder": current_path.rsplit('/', 1)[0] if '/' in current_path else "Home"
            })
            folder_doc.insert(ignore_permissions=True)

    return current_path


def get_year_month_folder() -> str:
    """Get or create a folder for current year/month.

    Returns folder path like "Home/2025/11"
    """
    now = datetime.now()
    year = str(now.year)
    month = str(now.month).zfill(2)  # Pad with zero: 01, 02, ..., 12

    folder_path = f"Home/{year}/{month}"
    return get_or_create_folder(folder_path)


@frappe.whitelist(methods=["POST"], allow_guest=False)
def upload_pending_document() -> dict:
    """Upload a file and create a linked Pending Document.

    Request should be multipart/form-data with a 'file' field.
    Files are organized into Home/YYYY/MM folders automatically.
    """
    uploaded = getattr(frappe.request, "files", {}).get("file")  # type: ignore[attr-defined]
    if not uploaded:
        frappe.throw("No file provided. Send multipart/form-data with field 'file'.")

    file_name = getattr(uploaded, "filename", None) or frappe.form_dict.get("file_name")

    # Check size BEFORE reading the entire file
    content_length = uploaded.content_length
    if content_length and content_length > 10 * 1024 * 1024:
        frappe.throw("File size exceeds 10 MB limit")

    content = uploaded.read() if hasattr(uploaded, "read") else uploaded.stream.read()

    content = uploaded.read() if hasattr(uploaded, "read") else uploaded.stream.read()
    if not content:
        frappe.throw("Uploaded file is empty")

    # Get or create year/month folder
    folder = get_year_month_folder()

    file_doc = frappe.get_doc(
        {
            "doctype": "File",
            "file_name": file_name,
            "is_private": 1,
            "content": content,
            "folder": folder,
        }
    ).insert(ignore_permissions=True)

    pending = frappe.get_doc(
        {
            "doctype": "Pending Document",
            "file": file_doc.name,
            "status": "Pending",
            "document_name": file_name,
            "party_type": 'Supplier'
        }
    ).insert(ignore_permissions=True)

    # Attach a comment if the file size is above 5 MB
    if content_length > 5 * 1024 * 1024:
        pending.add_comment(
            "Info",
            "Large file uploaded (>5 MB). Processing might take longer than usual."
        )

    return {
        "name": pending.name,
        "file_url": file_doc.file_url,
        "file_name": file_doc.file_name,
        "status": pending.status,
        "document_name": pending.get("document_name"),
        "party_type": pending.get("party_type"),
        "party": pending.get("party")
    }


@frappe.whitelist()
def create_pending_from_file(
    file:str | None = None,
    file_url:str | None = None,
    type:str | None = None,
    document_name:str | None = None,
) -> dict:
    """Create a Pending Document from an existing File document or file_url.

    Args can be provided either 'file' (File.name) or 'file_url'.
    """
    file_doc = None
    if file:
        file_doc = frappe.get_doc("File", file)
    elif file_url:
        file_doc = frappe.get_all("File", filters={"file_url": file_url}, fields=["name", "file_name"], limit=1)
        if not file_doc:
            frappe.throw("File with given file_url not found")
        file_doc = frappe.get_doc("File", file_doc[0].name)
    else:
        frappe.throw("Please specify either 'file' or 'file_url'")

    if document_name == None:
        document_name = file_doc.file_name

    pending = frappe.get_doc(
        {
            "doctype": "Pending Document",
            "file": file_doc.name,
            "type": (type or "Other").title(),
            "status": "Pending",
            "document_name": document_name
        }
    ).insert()

    return {"name": pending.name}


@frappe.whitelist()
def get_item_codes_for_barcodes(barcodes):
    """Map barcodes to item codes using Item Barcode master.

    Args:
        barcodes: List of barcode strings to lookup (can be list or JSON string)

    Returns:
        Dictionary mapping barcode -> item_code
    """
    import json

    if not barcodes:
        return {}

    if isinstance(barcodes, str):
        try:
            barcodes = json.loads(barcodes)
        except (json.JSONDecodeError, TypeError):
            barcodes = [barcodes]

    # Ensure it's a list
    if not isinstance(barcodes, list):
        barcodes = [barcodes]

    item_barcodes = frappe.get_all(
        "Item Barcode",
        filters={"barcode": ["in", barcodes]},
        fields=["barcode", "parent", "uom"],
    )

    mapping = {}
    # TODO: a single SQL query would be more efficient
    for item_barcode in item_barcodes:
        mapping[item_barcode.barcode] = {
            "item_code": item_barcode.parent,
            "item_name": frappe.db.get_value("Item", item_barcode.parent, "item_name"),
            "uom": item_barcode.uom or frappe.db.get_value("Item", item_barcode.parent, "stock_uom"),
        }

    return mapping
