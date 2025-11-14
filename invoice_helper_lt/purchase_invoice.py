from __future__ import annotations

import json
from typing import Optional

import frappe


@frappe.whitelist()
def apply_from_pending_document(purchase_invoice: str, pending: str) -> dict:
    """Apply metadata and attachments from a Pending Document to a Purchase Invoice.

    Keeps client simple (no JSON parsing on the form). We set supplier/bill_no when available
    and attach the source file to the Purchase Invoice.
    """
    pd = frappe.get_doc("Pending Document", pending)
    pi = frappe.get_doc("Purchase Invoice", purchase_invoice)

    # Basic mappings from Pending Document fields
    if (pd.get("party_type") or "").lower() == "supplier" and pd.get("party"):
        pi.supplier = pd.party
    if pd.get("bill_no"):
        pi.bill_no = pd.bill_no

    # Optional: if extraction_json has a recognizable posting date, set it
    # Expected minimal schema: {"posting_date": "YYYY-MM-DD"}
    posting_date = _get_posting_date_from_json(pd.get("extraction_json"))
    if posting_date and not pi.get("posting_date"):
        pi.posting_date = posting_date

    pi.save(ignore_permissions=True)

    # Attach the original file to the Purchase Invoice
    if pd.file:
        _attach_pending_file_to_doc(pd.file, "Purchase Invoice", pi.name)

    return {"ok": True}


def _get_posting_date_from_json(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    try:
        data = json.loads(raw)
        # allow nested under header as well
        if isinstance(data, dict):
            if isinstance(data.get("posting_date"), str):
                return data["posting_date"]
            header = data.get("header")
            if isinstance(header, dict) and isinstance(header.get("posting_date"), str):
                return header["posting_date"]
    except Exception:
        return None
    return None


def _attach_pending_file_to_doc(file_name: str, doctype: str, docname: str) -> None:
    file_doc = frappe.get_doc("File", file_name)
    # Create a new File entry attached to the target document, re-using file_url
    frappe.get_doc(
        {
            "doctype": "File",
            "file_name": file_doc.file_name,
            "file_url": file_doc.file_url,
            "is_private": file_doc.is_private,
            "attached_to_doctype": doctype,
            "attached_to_name": docname,
            "folder": "Home/Attachments",
        }
    ).insert(ignore_permissions=True)
