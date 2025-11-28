import io

import frappe
from frappe.model.document import Document


class PendingDocument(Document):
	def before_insert(self):
		self._set_party_type()
		self._check_document_name()

	def before_save(self):
		self._set_party_type()

	def _set_party_type(self):
		if self.type == "Purchase":
			self.party_type = "Supplier"
		elif self.type == "Sale":
			self.party_type = "Customer"

	def _check_document_name(self):
		if not self.document_name and self.file:
			file_doc = frappe.get_doc("File", self.file)
			self.document_name = file_doc.file_name
