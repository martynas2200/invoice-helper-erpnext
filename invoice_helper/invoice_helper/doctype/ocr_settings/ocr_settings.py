import frappe
from frappe.model.document import Document


class OCRSettings(Document):
	"""
	Settings document for OCR (Optical Character Recognition) configuration.

	This is a Single DocType that stores Tesseract and document processing settings
	for local invoice extraction methods.
	"""

	def before_save(self):
		"""Validate settings before saving."""
		if self.header_rows_limit and self.header_rows_limit < 1:
			frappe.throw(frappe._("Header Rows Limit must be at least 1"))
		if self.row_threshold and self.row_threshold < 1:
			frappe.throw(frappe._("Row Threshold must be at least 1"))

	def after_save(self):
		"""Clear cache after settings are saved."""
		frappe.cache().delete_key("ocr_settings_cache")


def get_ocr_settings():
	"""
	Get OCR settings from database with fallback to defaults.
	Useful for retrieving settings in extraction functions.
	"""
	try:
		settings = frappe.get_doc("OCR Settings")
		return {
			"ocr_lang": settings.ocr_lang or "lit",
			"ocr_config": settings.ocr_config or "--oem 3 --psm 6",
			"header_rows_limit": settings.header_rows_limit or 60,
			"row_threshold": settings.row_threshold or 20,
			"ignored_ids": {row.id_value for row in settings.ignored_ids} if settings.ignored_ids else set(),
		}
	except frappe.DoesNotExistError:
		# Return defaults if settings don't exist yet
		return {
			"ocr_lang": "lit",
			"ocr_config": "--oem 3 --psm 6",
			"header_rows_limit": 60,
			"row_threshold": 20,
			"ignored_ids": set(),
		}
