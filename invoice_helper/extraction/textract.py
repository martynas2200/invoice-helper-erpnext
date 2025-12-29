"""
Amazon Textract integration for document extraction.

This module provides utilities to integrate with AWS Textract service
for extracting text and structured data from documents.
"""

import os
import time
import uuid

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
		settings = frappe.get_doc("Textract Settings")
		self.aws_access_key = settings.aws_access_key
		self.aws_secret_key = settings.get_password("aws_secret_key")
		self.region = settings.region or "us-east-1"
		self.enabled = settings.enabled or False
		self.s3_bucket = getattr(settings, "s3_bucket", None)
		self.s3_prefix = (getattr(settings, "s3_prefix", None) or "").strip("/")

		if not self.enabled:
			# assuming we checked before initialization that Textract is enabled
			frappe.throw(
				frappe._("Textract integration is not enabled. Please configure it in Textract Settings.")
			)

		if not self.aws_access_key or not self.aws_secret_key:
			frappe.throw(
				frappe._("AWS credentials are not configured. Please set them in Textract Settings.")
			)

		self.client = boto3.client(
			"textract",
			region_name=self.region,
			aws_access_key_id=self.aws_access_key,
			aws_secret_access_key=self.aws_secret_key,
		)

		self.s3_client = boto3.client(
			"s3",
			region_name=self.region,
			aws_access_key_id=self.aws_access_key,
			aws_secret_access_key=self.aws_secret_key,
		)

	def _ensure_s3_bucket_configured(self) -> None:
		"""Ensure S3 bucket is configured for async Textract operations."""
		if not self.s3_bucket:
			frappe.throw(
				frappe._("Textract S3 bucket is not configured. Please set 's3_bucket' in Textract Settings.")
			)

	def _upload_to_s3(self, file_content: bytes, filename: str) -> tuple[str, str]:
		"""Upload a file to the configured S3 bucket for async processing.

		Args:
			file_content: Raw file bytes
			filename: Original filename (used only to build the S3 key)

		Returns:
			Tuple of (bucket, key)
		"""
		self._ensure_s3_bucket_configured()
		base_name = os.path.basename(filename) or "document"
		upload_key = f"{uuid.uuid4()}-{base_name}"
		if self.s3_prefix:
			upload_key = f"{self.s3_prefix}/{upload_key}"

		frappe.logger().info(
			f"Textract: Uploading document to S3 bucket '{self.s3_bucket}' with key '{upload_key}'"
		)
		self.s3_client.put_object(Bucket=self.s3_bucket, Key=upload_key, Body=file_content)
		return self.s3_bucket, upload_key

	def _wait_for_job(self, job_id: str, job_type: str) -> list[dict]:
		"""Poll Textract async job until completion and return all pages.

		Args:
			job_id: Textract JobId
			job_type: "TEXT" for text detection, "ANALYSIS" for document analysis

		Returns:
			List of paginated Textract responses (one per page/batch)
		"""
		if job_type == "TEXT":
			get_fn = self.client.get_document_text_detection
			job_label = "StartDocumentTextDetection"
		else:
			get_fn = self.client.get_document_analysis
			job_label = "StartDocumentAnalysis"

		max_tries = 60
		delay_seconds = 15

		for attempt in range(max_tries):
			result = get_fn(JobId=job_id)
			status = result.get("JobStatus")
			frappe.logger().info(
				f"Textract: {job_label} job {job_id} status: {status} (attempt {attempt + 1}/{max_tries})"
			)

			if status in {"SUCCEEDED", "FAILED", "PARTIAL_SUCCESS"}:
				if status != "SUCCEEDED":
					frappe.logger().warning(
						f"Textract: {job_label} job {job_id} completed with status {status}"
					)

				# Collect all pages using pagination (first page is current result)
				pages: list[dict] = [result]
				next_token = result.get("NextToken")
				while next_token:
					page = get_fn(JobId=job_id, NextToken=next_token)
					pages.append(page)
					next_token = page.get("NextToken")

				return pages

			time.sleep(delay_seconds)

		frappe.throw(
			frappe._(
				f"Textract async job {job_id} did not complete in time. Please try again or check AWS console."
			)
		)

	def _start_async_text_detection(self, bucket: str, key: str) -> list[dict]:
		"""Start and wait for an async StartDocumentTextDetection job."""
		frappe.logger().info(f"Textract: Starting StartDocumentTextDetection for s3://{bucket}/{key}")
		response = self.client.start_document_text_detection(
			DocumentLocation={"S3Object": {"Bucket": bucket, "Name": key}}
		)
		job_id = response["JobId"]
		return self._wait_for_job(job_id, job_type="TEXT")

	def _start_async_document_analysis(self, bucket: str, key: str, feature_types: list[str]) -> list[dict]:
		"""Start and wait for an async StartDocumentAnalysis job."""
		frappe.logger().info(
			f"Textract: Starting StartDocumentAnalysis for s3://{bucket}/{key} with FeatureTypes={feature_types}"
		)
		response = self.client.start_document_analysis(
			DocumentLocation={"S3Object": {"Bucket": bucket, "Name": key}},
			FeatureTypes=feature_types,
		)
		job_id = response["JobId"]
		return self._wait_for_job(job_id, job_type="ANALYSIS")

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
		if not s3_uri.startswith("s3://"):
			raise ValueError(f"Invalid S3 URI format: {s3_uri}")

		parts = s3_uri[5:].split("/", 1)
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
			# Parse S3 path if provided, otherwise upload local file to S3
			temporary_upload = False
			if file_path.startswith("s3://"):
				bucket, key = self._parse_s3_uri(file_path)
				frappe.logger().info(f"Textract: Using S3 object - Bucket: {bucket}, Key: {key}")
			else:
				# Local file path - read and upload to S3 for async processing
				frappe.logger().info(f"Textract: Reading local file: {file_path}")
				with open(file_path, "rb") as f:
					file_content = f.read()

				file_size = len(file_content)
				file_magic = file_content[:4].hex() if len(file_content) >= 4 else "unknown"
				frappe.logger().info(f"Textract: File size: {file_size} bytes, Magic bytes: {file_magic}")

				bucket, key = self._upload_to_s3(file_content, file_path)
				temporary_upload = True

			# Use async Textract API for multi-page support
			result = None
			try:
				pages = self._start_async_text_detection(bucket, key)
				result = self._parse_response(pages)
			finally:
				if temporary_upload:
					try:
						frappe.logger().info(
							f"Textract: Deleting temporary S3 object s3://{bucket}/{key} after processing"
						)
						self.s3_client.delete_object(Bucket=bucket, Key=key)
					except Exception as cleanup_err:
						frappe.logger().warning(
							f"Textract: Failed to delete temporary S3 object s3://{bucket}/{key}: {cleanup_err!s}"
						)

			return result
		except Exception as e:
			frappe.logger().error(f"Textract extraction error: {e!s}")
			frappe.log_error("Textract Extraction Error", f"Textract extraction error: {e!s}")
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
			# Upload bytes to S3 and use async text detection for multi-page support
			bucket, key = self._upload_to_s3(file_content, "document")
			result = None
			try:
				pages = self._start_async_text_detection(bucket, key)
				result = self._parse_response(pages)
			finally:
				try:
					frappe.logger().info(
						f"Textract: Deleting temporary S3 object s3://{bucket}/{key} after processing"
					)
					self.s3_client.delete_object(Bucket=bucket, Key=key)
				except Exception as cleanup_err:
					frappe.logger().warning(
						f"Textract: Failed to delete temporary S3 object s3://{bucket}/{key}: {cleanup_err!s}"
					)

			return result
		except Exception as e:
			frappe.logger().error(f"Textract extraction error: {e!s}")
			frappe.log_error("Textract Extraction Error", f"Textract extraction error: {e!s}")
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
			# Parse S3 path if provided, otherwise upload local file to S3
			temporary_upload = False
			if file_path.startswith("s3://"):
				bucket, key = self._parse_s3_uri(file_path)
				frappe.logger().info(f"Textract: Using S3 object - Bucket: {bucket}, Key: {key}")
			else:
				frappe.logger().info(f"Textract: Reading local file: {file_path}")
				with open(file_path, "rb") as f:
					file_content = f.read()

				file_size = len(file_content)
				file_magic = file_content[:4].hex() if len(file_content) >= 4 else "unknown"
				frappe.logger().info(f"Textract: File size: {file_size} bytes, Magic bytes: {file_magic}")

				bucket, key = self._upload_to_s3(file_content, file_path)
				temporary_upload = True

			frappe.logger().info(
				"Textract: Starting async StartDocumentAnalysis call with FeatureTypes=['TABLES']"
			)
			result = None
			try:
				pages = self._start_async_document_analysis(bucket, key, ["TABLES"])
				result = self._parse_tables_response(pages)
			finally:
				if temporary_upload:
					try:
						frappe.logger().info(
							f"Textract: Deleting temporary S3 object s3://{bucket}/{key} after processing"
						)
						self.s3_client.delete_object(Bucket=bucket, Key=key)
					except Exception as cleanup_err:
						frappe.logger().warning(
							f"Textract: Failed to delete temporary S3 object s3://{bucket}/{key}: {cleanup_err!s}"
						)

			return result
		except Exception as e:
			frappe.logger().error(f"Textract table extraction error: {e!s}")
			frappe.log_error("Textract Extraction Error", f"Textract table extraction error: {e!s}")
			raise

	def _parse_response(self, response: dict) -> dict[str, any]:
		"""Parse Textract API response and extract text.

		Args:
			response: Raw response from Textract API. Can be a single
				response dict or a list of paginated responses from an async
				operation.

		Returns:
			Dictionary with extracted text
		"""
		# Normalise response into a single Blocks list
		if isinstance(response, list):
			blocks = []
			for page in response:
				blocks.extend(page.get("Blocks", []))
		else:
			blocks = response.get("Blocks", [])
		extracted_text = ""
		confidence_data = []

		# Extract text blocks and organize by confidence/relevance
		for item in blocks:
			if item["BlockType"] == "LINE":
				confidence = item.get("Confidence", 0)
				text = item.get("Text", "")
				extracted_text += text + "\n"
				confidence_data.append({"text": text, "confidence": confidence})

		return {"text": extracted_text.strip(), "blocks": confidence_data, "raw_response": response}

	def _parse_tables_response(self, response: dict) -> dict[str, any]:
		"""Parse Textract tables response and extract table data.

		Args:
			response: Raw response from Textract AnalyzeDocument or a list
				of paginated responses from an async StartDocumentAnalysis
				operation.

		Returns:
			Dictionary with extracted tables
		"""
		# Normalise response into a single Blocks list
		if isinstance(response, list):
			blocks = []
			for page in response:
				blocks.extend(page.get("Blocks", []))
		else:
			blocks = response.get("Blocks", [])
		tables = []

		# Extract tables from response
		for item in blocks:
			if item["BlockType"] == "TABLE":
				table_data = {
					"id": item.get("Id"),
					"confidence": item.get("Confidence", 0),
					"rows": self._extract_table_rows(item, blocks),
				}
				tables.append(table_data)

		return {"tables": tables, "raw_response": response}

	def _extract_table_rows(self, table_block: dict, response: dict) -> list:
		"""Extract rows from a table block.

		Args:
			table_block: The TABLE block
			response: The full response containing all blocks or a flat
				Blocks list.

		Returns:
			List of rows with cell data
		"""
		rows = []
		cell_map = {}
		blocks = response if isinstance(response, list) else response.get("Blocks", [])

		# First, build a map of all cells in the table
		for rel in table_block.get("Relationships", []):
			if rel["Type"] == "CHILD":
				for cell_id in rel.get("Ids", []):
					cell_block = next((b for b in blocks if b["Id"] == cell_id), None)
					if cell_block and cell_block["BlockType"] == "CELL":
						row_index = cell_block.get("RowIndex", 0)
						col_index = cell_block.get("ColumnIndex", 0)

						if row_index not in cell_map:
							cell_map[row_index] = {}

						cell_text = self._get_text_from_block(cell_block, response)
						cell_map[row_index][col_index] = {
							"text": cell_text,
							"confidence": cell_block.get("Confidence", 0),
						}

		# Convert cell map to rows
		for row_index in sorted(cell_map.keys()):
			row_data = []
			for col_index in sorted(cell_map[row_index].keys()):
				row_data.append(cell_map[row_index][col_index])
			rows.append(row_data)

		return rows

	def _get_text_from_block(self, block: dict, response: dict) -> str:
		"""Get text content from a block by looking up child relationships.

		Args:
			block: The block to extract text from
			response: The full response containing all blocks or a flat
				Blocks list.

		Returns:
			Combined text from child blocks
		"""
		text = ""
		relationships = block.get("Relationships", [])
		blocks = response if isinstance(response, list) else response.get("Blocks", [])

		for rel in relationships:
			if rel["Type"] == "CHILD":
				for child_id in rel.get("Ids", []):
					child_block = next((b for b in blocks if b["Id"] == child_id), None)
					if child_block and child_block["BlockType"] == "WORD":
						text += child_block.get("Text", "") + " "

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
		settings = frappe.get_doc("Textract Settings")
		return settings.enabled and bool(settings.aws_access_key) and bool(settings.aws_secret_key)
	except Exception:
		return False
