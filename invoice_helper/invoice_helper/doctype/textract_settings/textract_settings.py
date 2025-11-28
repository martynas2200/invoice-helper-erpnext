import frappe
from frappe.model.document import Document


class TextractSettings(Document):
	"""
	Settings document for Amazon Textract integration.

	This is a Single DocType that stores AWS credentials and configuration
	for the Textract document extraction service.
	"""

	def before_save(self):
		"""Validate settings before saving."""
		if self.enabled:
			if not self.aws_access_key or not self.aws_secret_key:
				frappe.throw(
					frappe._("AWS Access Key and Secret Key are required when enabling Textract integration")
				)

	def after_save(self):
		"""Clear cache after settings are saved."""
		frappe.cache().delete_key("textract_settings_cache")
