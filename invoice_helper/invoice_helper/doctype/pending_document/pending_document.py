import frappe
from frappe.model.document import Document


class PendingDocument(Document):
	def before_insert(self):
		self._check_document_name()

	def _check_document_name(self):
		if not self.document_name and self.file:
			file_doc = frappe.get_doc("File", self.file)
			self.document_name = file_doc.file_name
