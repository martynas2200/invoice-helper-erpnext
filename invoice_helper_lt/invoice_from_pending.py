from __future__ import annotations

import json
from typing import Optional

import frappe


@frappe.whitelist()
def apply_from_pending_document(target_invoice: str, pending: str) -> dict:
    """Apply metadata and attachment from Pending Document to a Purchase or Sales Invoice.

    Automatically detects target doctype and maps supplier/customer, bill_no, posting_date.
    """
    pd = frappe.get_doc("Pending Document", pending)
    pi = frappe.get_doc("Purchase Invoice", target_invoice) if _is_purchase_invoice(target_invoice) else frappe.get_doc("Sales Invoice", target_invoice)
    doctype = pi.doctype

    # Map party based on party_type
    party_type = (pd.get("party_type") or "").lower()
    if party_type == "supplier" and doctype == "Purchase Invoice" and pd.get("party"):
        pi.supplier = pd.party
    elif party_type == "customer" and doctype == "Sales Invoice" and pd.get("party"):
        pi.customer = pd.party

    if hasattr(pi, "bill_no") and pd.get("bill_no"):
        pi.bill_no = pd.bill_no

    posting_date = _get_posting_date_from_json(pd.get("extraction_json"))
    if posting_date and not pi.get("posting_date"):
        pi.posting_date = posting_date

    pi.save(ignore_permissions=True)

    # Attach original file
    if pd.file:
        _attach_pending_file_to_doc(pd.file, doctype, pi.name)

    return {"ok": True, "doctype": doctype, "name": pi.name}


def _is_purchase_invoice(name: str) -> bool:
    # Heuristic: try fetching as Purchase Invoice first; fallback to Sales Invoice
    try:
        frappe.get_value("Purchase Invoice", name, "name")
        return True
    except Exception:
        return False


def _get_posting_date_from_json(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    try:
        data = json.loads(raw)
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
