import json
from datetime import timedelta

import frappe
from frappe import _

from invoice_helper.extraction.local import process_invoice
from invoice_helper.extraction.tabula import extract_tables_from_pdf
from invoice_helper.extraction.textract import get_textract_extractor, is_textract_enabled

logger = frappe.logger("invoice_helper.tasks")
logger.setLevel("DEBUG")


def cleanup_pending_documents():
	"""
	Delete stale Pending Documents that are already processed by the user.

	A Pending Document is deleted when:
	- its status is Used, Moved, Split or Error
	- and its last modification timestamp is older than configured retention days
	"""
	from invoice_helper.invoice_helper.doctype.ocr_settings.ocr_settings import get_ocr_settings

	settings = get_ocr_settings()
	cleanup_days = settings.get("pending_document_cleanup_days", 30)

	if cleanup_days is None or cleanup_days < 0:
		cleanup_days = 30

	if cleanup_days == 0:
		logger.info("Skipping Pending Document cleanup because cleanup days is set to 0")
		return

	cutoff = frappe.utils.now_datetime() - timedelta(days=cleanup_days)
	stale_docs = frappe.get_all(
		"Pending Document",
		filters={"status": ["in", ["Error", "Split", "Used", "Moved"]], "modified": ["<", cutoff]},
		pluck="name",
	)

	if not stale_docs:
		logger.info("No stale Pending Documents found for cleanup")
		return

	deleted_count = 0
	for docname in stale_docs:
		try:
			frappe.delete_doc("Pending Document", docname, ignore_permissions=True)
			deleted_count += 1
		except Exception as error:
			logger.warning(f"Failed to delete Pending Document {docname}: {error!s}")

	frappe.db.commit()
	logger.info(
		"Pending Document cleanup finished. "
		f"Deleted {deleted_count}/{len(stale_docs)} records older than {cleanup_days} day(s)."
	)


def find_party_by_tax_or_business_code(tax_code, business_code, party_type="Supplier"):
	"""
	Find a Supplier or Customer based on tax code and business ID.

	Searches for a matching party by:
	1. First tries to match by tax_code (VAT code)
	2. If not found, tries to match by business_code

	Args:
		tax_code: VAT/Tax code of the party
		business_code: Business code of the party
		party_type: Either "Supplier" or "Customer"

	Returns:
		str: Name of the matching document, or None if not found
	"""
	if not party_type or party_type not in ["Supplier", "Customer"]:
		return None

	# Try to find by tax_code first
	if tax_code:
		try:
			parties = frappe.get_list(
				party_type, filters={"tax_id": tax_code}, limit_page_length=1, ignore_permissions=True
			)
			if parties:
				logger.info(f"Found {party_type} by tax_code {tax_code}: {parties[0]['name']}")
				return parties[0]["name"]
		except Exception as e:
			logger.warning(f"Error searching {party_type} by tax_code: {e!s}")

	# Try to find by business_code if tax_code didn't match
	if business_code:
		try:
			parties = frappe.get_list(
				party_type,
				filters={"business_code": business_code},
				limit_page_length=1,
				ignore_permissions=True,
			)
			if parties:
				logger.info(f"Found {party_type} by business_code {business_code}: {parties[0]['name']}")
				return parties[0]["name"]
		except Exception as e:
			logger.warning(f"Error searching {party_type} by business_code: {e!s}")

	logger.info(f"No {party_type} found for tax_code={tax_code}, business_code={business_code}")
	return None


def extract_document(doc_name):
	"""
	Background task to extract data from a Pending Document.

	This task will be enqueued when a new Pending Document is inserted.
	It handles the extraction process by calling extraction methods (local or Textract)
	and updating the document with extracted data.

	Args:
		doc_name: Name of the Pending Document to extract
	"""
	try:
		# Fetch the pending document
		pending_doc = frappe.get_doc("Pending Document", doc_name)

		pending_doc.update({"status": "Processing"})
		pending_doc.save(ignore_permissions=True)
		# Commit early so we don't hold locks while doing long-running extraction
		frappe.db.commit()
		frappe.db.commit()

		# Get file path from the linked file
		if not pending_doc.file:
			logger.error(f"No file attached to Pending Document: {doc_name}")
			pending_doc.status = "Error"
			pending_doc.error_message = "No file attached"
			pending_doc.save(ignore_permissions=True)
			return

		# Get the file document and extract path
		file_doc = frappe.get_doc("File", pending_doc.file)
		file_path = file_doc.get_full_path()

		# Process the invoice PDF
		logger.info(f"Starting invoice extraction for: {file_path}")
		invoice_data = process_invoice(file_path)

		if invoice_data is None:
			raise Exception("Failed to process invoice PDF")

		# Local extraction with Tabula
		tables = extract_tables_from_pdf(file_path)
		invoice_data["local_tables"] = tables

		# Amazon Textract if enabled
		tables_data = None
		if is_textract_enabled():
			try:
				extractor = get_textract_extractor()
				tables_result = extractor.extract_tables(file_path)
				tables_data = tables_result.get("tables", [])
				logger.info(f"Successfully extracted {len(tables_data)} table(s) from document")
				if tables_data:
					invoice_data["tables"] = tables_data
			except Exception as textract_error:
				logger.warning(f"Textract extraction failed: {textract_error!s}")
				# add comment to pending document
				pending_doc.add_comment(
					"Comment", f"{_('Amazon Textract extraction failed.')} <br>{textract_error!s}"
				)
				# Continue processing even if Textract fails
		if isinstance(invoice_data.get("bill_no"), list):
			invoice_data["bill_no"] = ",".join(invoice_data["bill_no"])

		# Map extracted data to pending document fields
		extracted_data = {
			"bill_date": invoice_data.get("bill_date"),
			"bill_no": invoice_data.get("bill_no"),
			"tax_code": invoice_data.get("supplier_vat"),  # TODO: change it
			"business_id": invoice_data.get("supplier_id"),  # TODO: change it
			"due_date": invoice_data.get("due_date"),
			"vat_amount": invoice_data.get("vat_amount"),
			"total_amount": invoice_data.get("total"),
			"subtotal_amount": invoice_data.get("subtotal"),
		}

		# Try to find and set the party (Supplier/Customer) based on tax code and business ID
		tax_code = invoice_data.get("supplier_vat")
		business_code = invoice_data.get("supplier_id")
		party_type = pending_doc.party_type or "Supplier"
		if party_type not in ["Supplier", "Customer"]:
			party_type = "Supplier"

		party = find_party_by_tax_or_business_code(tax_code, business_code, party_type)
		if party:
			extracted_data["party"] = party
			logger.info(f"Matched party: {party_type} - {party}")
		else:
			logger.warning(
				f"Could not match {party_type} for tax_code={tax_code}, business_code={business_code}"
			)
		# Format barcodes from line items into Pending Document Barcode table
		if invoice_data.get("re_barcodes"):
			extracted_data["re_barcodes"] = [{"barcode": barcode} for barcode in invoice_data["re_barcodes"]]

		# Add line items
		if invoice_data.get("line_items"):
			extracted_data["items"] = [
				{
					"barcode": item.get("barcode", ""),
					"quantity": item.get("quantity", ""),
					"price": item.get("price", ""),
					"total": item.get("total", ""),
				}
				for item in invoice_data["line_items"]
			]

		# extraction_json
		try:
			extraction_json = json.dumps(invoice_data, indent=2, ensure_ascii=False, default=str)
		except TypeError:
			# Fallback to simple serialization if something is not serializable
			extraction_json = json.dumps(invoice_data, default=str)
		extracted_data["extraction_json"] = extraction_json

		# Update the pending document with extracted data
		extracted_data["status"] = "Extracted"
		final = frappe.get_doc("Pending Document", doc_name)
		final.update(extracted_data)
		final.save(ignore_permissions=True)
		frappe.db.commit()

		frappe.msgprint("Document extraction done!", indicator="green")

		# Log successful extraction
		logger.info(f"Extraction task completed for Pending Document: {doc_name}")

	except Exception as e:
		import traceback

		error_traceback = traceback.format_exc()
		logger.error(f"Error extracting Pending Document {doc_name}: {e!s}\n{error_traceback}")
		# Update document status to indicate error
		try:
			pending_doc = frappe.get_doc("Pending Document", doc_name)
			pending_doc.status = "Error"
			pending_doc.save(ignore_permissions=True)
			frappe.db.commit()
			# attach a comment with the error message and full stack trace
			pending_doc.add_comment(
				"Comment", f"{_('Extraction failed with error:')} {e!s}<br><pre>{error_traceback!s}</pre>"
			)
		except Exception as update_error:
			logger.error(f"Failed to update error status: {update_error!s}")
