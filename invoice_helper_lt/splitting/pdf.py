"""
PDF Splitter
"""

import io
from pathlib import Path
from PyPDF2 import PdfReader, PdfWriter
import frappe

def parse_page_ranges(range_string):
    """
    Parse a page range string like "1-2,3,4-5" into a list of tuples.

    Args:
        range_string: String containing page ranges separated by commas

    Returns:
        List of tuples, where each tuple is (start_page, end_page)

    Example:
        "1-2,3,4-5" -> [(1, 2), (3, 3), (4, 5)]
    """
    ranges = []
    parts = range_string.split(',')

    for part in parts:
        part = part.strip()
        if '-' in part:
            start, end = part.split('-')
            ranges.append((int(start), int(end)))
        else:
            page = int(part)
            ranges.append((page, page))

    return ranges

@frappe.whitelist()
def split_pdf_file(file_name, page_ranges, output_folder=None):
    """
    Split a PDF file from File doctype into multiple documents.

    Args:
        file_name: The name of the File document in Frappe (file name or doc id)
        page_ranges: List of tuples (start_page, end_page) or a page range string
                    If string, format should be like "1-2,3,4-5"
        output_folder: Frappe folder name where split PDFs should be saved
                      (default: same folder as source file)

    Returns:
        List of created File document names

    Raises:
        ImportError: If Frappe is not available
        FileNotFoundError: If the source file doesn't exist in Frappe
        ValueError: If page ranges are invalid

    """
    if isinstance(page_ranges, str):
        page_ranges = parse_page_ranges(page_ranges)

    file_doc = frappe.get_doc("File", file_name)

    file_path = file_doc.get_full_path()

    if not Path(file_path).exists():
        frappe.throw(f"PDF file not found at path: {file_path}")

    reader = PdfReader(file_path)
    total_pages = len(reader.pages)

    frappe.logger().debug(f"Splitting File: {file_doc.file_name}")
    frappe.logger().debug(f"Total pages: {total_pages}")
    frappe.logger().debug(f"Splitting into {len(page_ranges)} documents...")

    created_file_docs = []
    output_prefix = Path(file_path).stem

    # Process each range
    for idx, (start_page, end_page) in enumerate(page_ranges, 1):
        if start_page < 1 or end_page > total_pages:
            frappe.throw(
                f"Invalid page range {start_page}-{end_page}. "
                f"PDF has {total_pages} pages (valid range: 1-{total_pages})"
            )

        if start_page > end_page:
            frappe.throw(
                f"Invalid page range {start_page}-{end_page}. "
                f"Start page must be <= end page"
            )

        writer = PdfWriter()

        for page_num in range(start_page - 1, end_page):
            writer.add_page(reader.pages[page_num])

        output_buffer = io.BytesIO()
        writer.write(output_buffer)
        pdf_content = output_buffer.getvalue()

        output_filename = f"{output_prefix}_{idx}.pdf"

        # Create a new File document in Frappe
        new_file_doc = frappe.new_doc("File")
        new_file_doc.file_name = output_filename
        new_file_doc.folder = output_folder or file_doc.folder
        new_file_doc.content = pdf_content
        new_file_doc.is_private = file_doc.is_private
        new_file_doc.attached_to_doctype = file_doc.attached_to_doctype
        new_file_doc.attached_to_name = file_doc.attached_to_name
        new_file_doc.attached_to_field = file_doc.attached_to_field
        new_file_doc.insert()

        created_file_docs.append(new_file_doc.name)
        print(f"  Created: {output_filename} (pages {start_page}-{end_page}) - ID: {new_file_doc.name}")

    return created_file_docs
