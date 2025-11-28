#!/usr/bin/env python3
"""
Table extraction using Tabula

This script extracts tables from PDF files using Tabula,
which handles slightly tilted pages well.

"""

import frappe
import pandas as pd


def extract_tables_from_pdf(pdf_path: str) -> list:
	"""
	Extract tables using Tabula-py.
	Returns a list of tables
	"""
	try:
		import tabula
	except ImportError:
		frappe.logger().error("Error: Tabula not installed, it also requires Java Runtime Environment (JRE)")
		return []

	# Extract tables from PDF
	try:
		tables = tabula.read_pdf(pdf_path, pages="all", multiple_tables=True)
	except Exception as e:
		frappe.logger().error(f"Error extracting tables: {e}")
		return []

	if not tables or len(tables) == 0:
		frappe.logger().error("No tables found in PDF")
		return []

	# Map results to resemble Amazon Textract structure
	remapped_tables = _remap_to_textract_format(tables)

	return remapped_tables


def _remap_to_textract_format(tabula_tables: list) -> list:
	"""
	Convert Tabula DataFrames to Amazon Textract table structure.

	Textract structure:
	{
	    "tables": [
	        {
	            "id": str,
	            "confidence": float (0-100),
	            "rows": [
	                [
	                    {"text": str, "confidence": float},
	                    ...
	                ],
	                ...
	            ]
	        }
	    ]
	}

	Args:
	    tabula_tables: List of pandas DataFrames from Tabula

	Returns:
	    List of dictionaries in Textract format
	"""
	remapped = []

	for idx, df in enumerate(tabula_tables):
		if not isinstance(df, pd.DataFrame):
			frappe.logger().warning(f"Table {idx} is not a DataFrame, skipping")
			continue

		# Convert DataFrame to rows of cells
		rows = []

		# Process header row
		header_row = []
		for col_name in df.columns:
			header_row.append(
				{
					"text": str(col_name),
				}
			)
		rows.append(header_row)

		# Process data rows
		for values in df.values:
			cells = [{"text": "" if pd.isna(value) else str(value).strip()} for value in values]
			rows.append(cells)

		table_data = {"id": f"tabula-table-{idx}", "rows": rows}
		remapped.append(table_data)

	return remapped
