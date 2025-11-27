"""
Amazon Textract integration for document extraction.

This module provides utilities to integrate with AWS Textract service
for extracting text and structured data from documents.
"""
import frappe

try:
	import boto3
except ImportError:
	boto3 = None


class TextractExtractor:

	def __init__(self):
		if not boto3:
			raise ImportError("boto3 is not installed. Please install it using: pip install boto3")

		# Load AWS credentials from Textract Settings
		settings = frappe.get_doc('Textract Settings')
		self.aws_access_key = settings.aws_access_key
		self.aws_secret_key = settings.get_password('aws_secret_key')
		self.region = settings.region or 'us-east-1'
		self.enabled = settings.enabled or False

		if not self.enabled:
			# assuming we checked before initialization that Textract is enabled
			frappe.throw(frappe._("Textract integration is not enabled. Please configure it in Textract Settings."))

		if not self.aws_access_key or not self.aws_secret_key:
			frappe.throw(frappe._("AWS credentials are not configured. Please set them in Textract Settings."))

		self.client = boto3.client(
			'textract',
			region_name=self.region,
			aws_access_key_id=self.aws_access_key,
			aws_secret_access_key=self.aws_secret_key
		)

	def _parse_s3_uri(self, s3_uri: str) -> tuple:
		"""
		Parse an S3 URI into bucket and key components.

		Args:
			s3_uri: S3 URI in format s3://bucket/key

		Returns:
			Tuple of (bucket, key)

		Raises:
			ValueError: If URI format is invalid
		"""
		if not s3_uri.startswith('s3://'):
			raise ValueError(f"Invalid S3 URI format: {s3_uri}")

		parts = s3_uri[5:].split('/', 1)
		if len(parts) != 2:
			raise ValueError(f"Invalid S3 URI format: {s3_uri}")

		bucket, key = parts
		return bucket, key

	def extract_from_document(self, file_path: str) -> dict[str, any]:
		"""
		Extract data from a document using Amazon Textract.

		Args:
			file_path: Path or S3 URI to the document

		Returns:
			Dictionary with extracted text and structured data
		"""
		try:
			# Parse S3 path if provided
			if file_path.startswith('s3://'):
				bucket, key = self._parse_s3_uri(file_path)
				response = self.client.detect_document_text(
					Document={
						'S3Object': {
							'Bucket': bucket,
							'Name': key
						}
					}
				)
				frappe.logger().info(f"Textract: Using S3 object - Bucket: {bucket}, Key: {key}")
			else:
				# Local file path - read and send bytes
				frappe.logger().info(f"Textract: Reading local file: {file_path}")
				with open(file_path, 'rb') as f:
					file_content = f.read()

				# Log file inspection details
				# file_size = len(file_content)
				# file_magic = file_content[:4].hex() if len(file_content) >= 4 else "unknown"
				# frappe.logger().info(f"Textract: File size: {file_size} bytes, Magic bytes: {file_magic}")

				# Check if it's a valid PDF
				# if file_content[:4] != b'%PDF':
				# 	frappe.logger().warning(f"Textract: File may not be a valid PDF! First 4 bytes: {file_content[:4]}")

				response = self.client.detect_document_text(
					Document={'Bytes': file_content}
				)
			return self._parse_response(response)
		except Exception as e:
			frappe.logger().error(f"Textract extraction error: {str(e)}", "Textract Extraction Error")
			frappe.log_error(f"Textract extraction error: {str(e)}", "Textract Extraction Error")
			raise

	def extract_from_bytes(self, file_content: bytes) -> dict[str, any]:
		"""
		Extract data from document bytes using Amazon Textract.

		Args:
			file_content: Raw file content bytes

		Returns:
			Dictionary with extracted text and structured data
		"""
		try:
			response = self.client.detect_document_text(
				Document={'Bytes': file_content}
			)
			return self._parse_response(response)
		except Exception as e:
			frappe.logger().error(f"Textract extraction error: {str(e)}", "Textract Extraction Error")
			frappe.log_error(f"Textract extraction error: {str(e)}", "Textract Extraction Error")
			raise

	def extract_tables(self, file_path: str) -> dict[str, any]:
		"""
		Extract tables using Amazon Textract.

		Args:
			file_path: Path or S3 URI to the document

		Returns:
			Dictionary with extracted tables
		"""
		try:
			# Parse S3 path if provided
			if file_path.startswith('s3://'):
				bucket, key = self._parse_s3_uri(file_path)
				doc_uri = {'S3Object': {'Bucket': bucket, 'Name': key}}
				frappe.logger().info(f"Textract: Using S3 object - Bucket: {bucket}, Key: {key}")
			else:
				# Local file path - read and send bytes
				frappe.logger().info(f"Textract: Reading local file: {file_path}")
				with open(file_path, 'rb') as f:
					file_content = f.read()

				# Log file inspection details
				file_size = len(file_content)
				file_magic = file_content[:4].hex() if len(file_content) >= 4 else "unknown"
				frappe.logger().info(f"Textract: File size: {file_size} bytes, Magic bytes: {file_magic}")

				# Check if it's a valid PDF
				if file_content[:4] != b'%PDF':
					frappe.logger().warning(f"Textract: File may not be a valid PDF! First 4 bytes: {file_content[:4]}")

				doc_uri = {'Bytes': file_content}

			frappe.logger().info(f"Textract: Starting AnalyzeDocument call with FeatureTypes=['TABLES']")
			response = self.client.analyze_document(
				Document=doc_uri,
				FeatureTypes=['TABLES']
			)
			return self._parse_tables_response(response)
		except Exception as e:
			frappe.logger().error(f"Textract table extraction error: {str(e)}", "Textract Extraction Error")
			frappe.log_error(f"Textract table extraction error: {str(e)}", "Textract Extraction Error")
			raise

	def _parse_response(self, response: dict) -> dict[str, any]:
		"""
		Parse Textract API response and extract text.

		Args:
			response: Raw response from Textract API

		Returns:
			Dictionary with extracted text
		"""
		extracted_text = ""
		confidence_data = []

		# Extract text blocks and organize by confidence/relevance
		for item in response.get('Blocks', []):
			if item['BlockType'] == 'LINE':
				confidence = item.get('Confidence', 0)
				text = item.get('Text', '')
				extracted_text += text + '\n'
				confidence_data.append({
					'text': text,
					'confidence': confidence
				})

		return {
			"text": extracted_text.strip(),
			"blocks": confidence_data,
			"raw_response": response
		}

	def _parse_tables_response(self, response: dict) -> dict[str, any]:
		"""
		Parse Textract tables response and extract table data.

		Args:
			response: Raw response from Textract AnalyzeDocument

		Returns:
			Dictionary with extracted tables
		"""
		tables = []

		# Extract tables from response
		for item in response.get('Blocks', []):
			if item['BlockType'] == 'TABLE':
				table_data = {
					'id': item.get('Id'),
					'confidence': item.get('Confidence', 0),
					'rows': self._extract_table_rows(item, response)
				}
				tables.append(table_data)

		return {
			"tables": tables,
			"raw_response": response
		}

	def _extract_table_rows(self, table_block: dict, response: dict) -> list:
		"""
		Extract rows from a table block.

		Args:
			table_block: The TABLE block
			response: The full response containing all blocks

		Returns:
			List of rows with cell data
		"""
		rows = []
		cell_map = {}

		# First, build a map of all cells in the table
		for rel in table_block.get('Relationships', []):
			if rel['Type'] == 'CHILD':
				for cell_id in rel.get('Ids', []):
					cell_block = next((b for b in response.get('Blocks', []) if b['Id'] == cell_id), None)
					if cell_block and cell_block['BlockType'] == 'CELL':
						row_index = cell_block.get('RowIndex', 0)
						col_index = cell_block.get('ColumnIndex', 0)

						if row_index not in cell_map:
							cell_map[row_index] = {}

						cell_text = self._get_text_from_block(cell_block, response)
						cell_map[row_index][col_index] = {
							'text': cell_text,
							'confidence': cell_block.get('Confidence', 0)
						}

		# Convert cell map to rows
		for row_index in sorted(cell_map.keys()):
			row_data = []
			for col_index in sorted(cell_map[row_index].keys()):
				row_data.append(cell_map[row_index][col_index])
			rows.append(row_data)

		return rows

	def _get_text_from_block(self, block: dict, response: dict) -> str:
		"""
		Get text content from a block by looking up child relationships.

		Args:
			block: The block to extract text from
			response: The full response containing all blocks

		Returns:
			Combined text from child blocks
		"""
		text = ""
		relationships = block.get('Relationships', [])

		for rel in relationships:
			if rel['Type'] == 'CHILD':
				for child_id in rel.get('Ids', []):
					child_block = next((b for b in response.get('Blocks', []) if b['Id'] == child_id), None)
					if child_block and child_block['BlockType'] == 'WORD':
						text += child_block.get('Text', '') + ' '

		return text.strip()


def get_textract_extractor() -> TextractExtractor:
	"""
	Factory function to get or create a Textract extractor instance.

	Returns:
		TextractExtractor instance

	Raises:
		frappe.ValidationError: If Textract is not enabled or credentials are missing
	"""
	return TextractExtractor()


def extract_with_textract(file_content: bytes) -> dict[str, any]:
	"""
	Quick function to extract data from file content using Textract.

	Args:
		file_content: Raw file bytes

	Returns:
		Dictionary with extracted data

	Raises:
		frappe.ValidationError: If Textract is not enabled or credentials are missing
	"""
	extractor = get_textract_extractor()
	return extractor.extract_from_bytes(file_content)


def is_textract_enabled() -> bool:
	"""
	Check if Textract integration is enabled and configured.

	Returns:
		True if Textract is enabled and has valid credentials
	"""
	try:
		settings = frappe.get_doc('Textract Settings')
		return settings.enabled and bool(settings.aws_access_key) and bool(settings.aws_secret_key)
	except Exception:
		return False

