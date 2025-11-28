"""
Local extraction methods for document processing.

Prioritized fields:
[*] Bill number
[ ] VAT amount

This module contains local/custom extraction methods that can be used
as fallbacks or alternatives to external APIs.
"""

import os
import re
from datetime import date, datetime

import frappe
import pytesseract
from pdf2image import convert_from_path
from PIL import Image

logger = frappe.logger()


def _get_ocr_settings():
	"""Load OCR settings from Frappe with environment variable fallback."""
	try:
		from invoice_helper.invoice_helper.doctype.ocr_settings.ocr_settings import get_ocr_settings

		return get_ocr_settings()
	except Exception as e:
		logger.warning(f"Failed to load OCR settings from database: {e}. Using defaults.")
		return {
			"ocr_lang": os.environ.get("OCR_LANG", "lit"),
			"ocr_config": os.environ.get("OCR_CONFIG", "--oem 3 --psm 6"),
			"header_rows_limit": int(os.environ.get("HEADER_ROWS_LIMIT", "60")),
			"row_threshold": int(os.environ.get("ROW_THRESHOLD", "20")),
			"ignored_ids": set(),
		}


# Load settings once at module import
_OCR_SETTINGS = _get_ocr_settings()

# Provide backward-compatible module-level variables
OCR_LANG = _OCR_SETTINGS["ocr_lang"]
OCR_CONFIG = _OCR_SETTINGS["ocr_config"]
HEADER_ROWS_LIMIT = _OCR_SETTINGS["header_rows_limit"]
ROW_THRESHOLD = _OCR_SETTINGS["row_threshold"]
REGEX_PATTERNS = {
	# Financial amount extraction
	"vat": r"(?<!su\s)(?<!su)(?<!be\s)(?<!be)(?:PVM|PVM suma|PVM 214|Taxes?)[:\s]*(?:\d+%\s*)?(?:\([A-Z]{3}\)\s*)?(?:[€£$]?\s*)?(\d+[.,]\d{2})",
	"vat_label": r"(?<!su\s)(?<!su)(?<!be\s)(?<!be)(?:PVM|PVM suma|PVM 214)",
	"total": r"(?:Iš viso|Sąskaitos suma|Viso su PVM|Suma apmokėjimui|Total|TOTAL)[:\s]*(?:\([A-Z]{3}\)\s*)?(?:[€£$]?\s*)?(\d+[.,]\d{2})",
	"subtotal": r"(?:Paslaugų suma|Viso be PVM|Suma be PVM|Subtotal)[:\s]*(?:\([A-Z]{3}\)\s*)?(?:[€£$]?\s*)?(\d+[.,]\d{2})",
	# Date patterns
	"date_yyyy_mm_dd": r"\b(20\d{2}|19\d{2})[-./](0?[1-9]|1[0-2])[-./](0?[1-9]|[12]\d|3[01])\b",
	"date_dd_mm_yyyy": r"\b(0?[1-9]|[12]\d|3[01])[-./](0?[1-9]|1[0-2])[-./](20\d{2}|19\d{2})\b",
	"lt_month_name": r"\b(20\d{2}|19\d{2})\s*m\.?\s*([A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]+)\s+(\d{1,2})\s*d\.?\b",
	"due_date": r"(?:Apmokėti iki|Apmoketi iki|Apmokėjimo terminas|Sumoketi iki|Sumokėti iki)[:\s]*((?:20|19)\d{2}[-./](?:0?[1-9]|1[0-2])[-./](?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])[-./](?:0?[1-9]|1[0-2])[-./](?:20|19)\d{2})",
	# General patterns
	"barcode": r"\b(\d{7,8}|\d{12,13})\b",
	"numeric_value": r"(\d+[.,]\d+|\d+)",
	"vat_code": r"\bLT\d{9}(?:\d{3})?\b",
}


def extract_re_barcodes(texts: list) -> dict:
	"""Extract RE barcodes from full text"""
	full_text = "\n".join(texts)
	barcodes = re.findall(REGEX_PATTERNS["barcode"], full_text)
	# Deduplicate preserving order
	seen = set()
	uniq_barcodes = []
	for bc in barcodes:
		if bc not in seen:
			uniq_barcodes.append(bc)
			seen.add(bc)
	return {"re_barcodes": uniq_barcodes}


def extract_invoice_number(text: str) -> str | None:
	"""
	Handle multiple Lithuanian invoice number formats.
	Small strings of text:
	    Achieves ~70% accuracy in tests when given a key based of FAKTURA/SĄSKAITA + 8 of keys below and above.
	    If I double check if that string of 17 keys contains expected series patterns and digits, and exclude the outliers, accuracy goes up to ~90%.
	! The problem with the current implementation when given full header context is there are too many matches.
	! TODO: add setting entry for expected series to filter matches better.
	! Or use coordinates/proximity scoring to FAKTURA/SĄSKAITA keywords.
	! Just let it be might train a small ML model for fun.

	This function extracts bill numbers from Lithuanian invoice OCR text.
	Handles patterns like:
	- "BD0004092473"   (series+digits together)
	- "VIK24/1/085333" (series+mixed+digits)
	- "VIK24/1 135529" (series with slash, space, then number)
	- "AMB Nr.6507523" (series, space, number separated)
	- "137S014387"     (digits+letter+digits mixed)
	- "B1LT Nr. 057596" (alphanumeric series with number)
	- "KRE NR.:0010"      (series, NR. with colon, number)
	- "BAL. NR.: 5495687" (series with dot, NR., number)
	- "IKI25S Nr. 115484" (alphanumeric series with separate number)
	- "MISF-000000011479" (series with dash+digits)
	- "LDN serija Nr.1961" (short series with "serija" keyword)
	- "MID 0589" (3-letter series with space and short number)
	- "T-153992" (1-letter series with dash and number)

	Args:
	    text: OCR text to extract bill numbers from
	    use_proximity_scoring: If True, filters matches by proximity to invoice markers
	"""
	# Multiple patterns to catch different formats
	patterns = [
		# 1. Single letter with dash: T-153992
		r"\b([A-Z])\-(\d{6})\b",
		# 2. Together with dash: Series - digits (like MISF-000000011479)
		r"\b([A-Z]{2,5}\-\d{6,})\b",
		# 3. Series with slash(es) followed by space and number: VIK24/1 135529
		r"\b([A-Z]+\d+/\d+)\s+(\d{6})\b",
		# 4. Together: Series + digits/chars + digits (not VAT like LT123456789)
		r"\b([A-Z]{2,5}[\d/\-]*\d{4,})\b(?![0-9]{3})",
		# 5. Alphanumeric series (like IKI25S, B1LT) followed by optional Nr. and digits
		r"\b([A-Z]+\d+[A-Z]*)\s*(?:Nr\.?|No\.?|Number)?\s*(\d{5,})\b",
		# 6. Short series with "serija" keyword: "LDN serija Nr.1961"
		r"\b([A-Z]{2,3})\s+(?:serija|sąskaita-faktūra)\s+(?:ir\s+)?(?:Nr\.?|No\.?)\s*(\d{3,})\b",
		# 7. Short series (2-3 letters) followed by space and short number: "MID 0589"
		r"\b([A-Z]{2,3})\s+(\d{3,4})\b(?![\d/\-])",
		# 8. Short series (2-4 letters) followed by NR./No. with optional colon and spaces, then digits
		r"\b([A-Z]{2,4})\.?\s*(?:NR|Nr|No)\s*\.?:?\s*(\d{4,})\b",
		# 9. Separated: Pure letter series (space/colon/etc) digits
		r"\b([A-Z]{2,6})\s*(?:Nr\.?|No\.?|Number)?\s*(\d{5,})\b",
		# 10. Digits start, letter in middle, digits end (like 137S014387)
		r"\b(\d{1,3}[A-Z]\d{6,})\b",
	]

	matches = []

	for pattern in enumerate(patterns):
		found = re.findall(pattern, text, re.IGNORECASE)  # Case-insensitive
		if found:
			if isinstance(found[0], tuple):
				matches.extend(["".join(str(g) for g in match if g) for match in found])
			else:
				matches.extend(found)

	# Remove VAT number patterns, postcodes, and bank accounts
	useless = re.compile(r"^(LT|kodas|EKA|EAA|PV|WBH)")  # Filter out VAT codes
	matches = [m for m in matches if not useless.match(m)]
	matches = list(set(matches))  # Remove duplicates

	# Might be a good idea to introduce proximity scoring here to FAKTURA or SĄSKAITA markers
	# For now, we simply prioritize known series patterns
	priority_series = re.compile(
		r"^(137S|AK|AMB|ARB|AVP|BAL|BBC|BD|BOS|DB|DEK|DEL|EASU|EASV|ELE|GKAU|GRAU|GSMP|GUD|HFL|IK|INAV|KA|KKF|KOOP|KRE|KRM|LAA|LAI|LDN|LPN|MAATC|MAG|MAX|MBN|MBWSE|MEDS|MEP|MES|MID|MISF|MISF|MJSF|MKP|MMB|MMB|MMK|MPV|MS|MVK|MVLT|NRA|OSC|OSM|PDK|PGA|PLW|PRE|PRK|RAD|RIA|RVI|SAL|SCT|SFK|SKF|SMBF|SMRP|SNT|T|TAB|TDN|UG|VE|VIGR|VIK|VLE|VLK|VLS|VLT|ZAG|ZAL)"
	)
	# TODO: pass the whole list to the frontend, and let the user pick?
	for match in matches:
		if priority_series.match(match):
			return [match]

	return matches


def extract_bill_date(text: str) -> str | None:
	"""
	Extract bill/invoice date from document text using local methods.

	Args:
	    text: The document text to search

	Returns:
	    Date string if found, None otherwise
	"""
	# TODO: Implement local regex patterns to extract date
	# Example patterns to match:
	# - Invoice Date: DD/MM/YYYY
	# - Date: DD-MM-YYYY
	# - ISO format: YYYY-MM-DD
	patterns = [
		r"[Ii]nvoice\s+[Dd]ate\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4})",
		r"[Dd]ate\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4})",
		r"(\d{4}-\d{1,2}-\d{1,2})",
	]

	for pattern in patterns:
		match = re.search(pattern, text)
		if match:
			return match.group(1)

	return None


def extract_totals(texts: list, coordinates: list | None) -> dict:
	# Initialize result (align keys with invoice_data structure)
	totals = {"subtotal": None, "vat_amount": None, "total": None}

	full_text = " ".join(texts)
	vat_matches = re.findall(REGEX_PATTERNS["vat"], full_text, re.IGNORECASE)
	total_matches = re.findall(REGEX_PATTERNS["total"], full_text, re.IGNORECASE)
	subtotal_matches = re.findall(REGEX_PATTERNS["subtotal"], full_text, re.IGNORECASE)

	if total_matches:
		totals["total"] = total_matches[-1]
	if subtotal_matches:
		totals["subtotal"] = subtotal_matches[-1]

	if vat_matches and float(vat_matches[-1].replace(",", ".")) != 21.00:
		totals["vat_amount"] = vat_matches[-1]
	else:
		#  try to find VAT label and then using coordinates try to go down to get the amount
		vat_possibilities = []
		#  USE COORDINATES
		if coordinates:
			vat_labels = []
			for i, text in enumerate(texts):
				if re.search(REGEX_PATTERNS["vat_label"], text, re.IGNORECASE):
					vat_labels.append((i, coordinates[i]))
					print(f"-> Found VAT label: {text} at index {i} with coords {coordinates[i]}")
			# For each found label, look for nearest text below it
			for label_idx, label_coord in enumerate(vat_labels):
				label_x0, label_y0, label_x1, label_y1 = label_coord
				nearest_below = None
				nearest_distance = float("inf")
				for j, coord in enumerate(coordinates):
					if j == label_idx:
						continue
					x0, y0, x1, y1 = coord
					# Check if this text is below the label (y0 > label_y1)
					if y0 > label_y1:
						distance = y0 - label_y1
						if distance < nearest_distance:
							nearest_distance = distance
							nearest_below = (j, texts[j])
				if nearest_below:
					nb_idx, nb_text = nearest_below
					# Check if this text looks like a numeric value
					if re.match(REGEX_PATTERNS["numeric_value"], nb_text):
						print(f"-> Found VAT amount: {nb_text} below label at index {label_idx}")
						try:
							vat_possibilities.append(float(nb_text.replace(",", ".")))
						except ValueError:
							pass
		# Pick the last found possibility as VAT amount
		if vat_possibilities:
			totals["vat_amount"] = str(vat_possibilities[-1])
		print(f"-> VAT possibilities found: {vat_possibilities}")

	return totals


def extract_business_id(header_rows: list) -> str:
	"""
	Extract business identification code from document text.
	TODO: NOT TESTED YET!
	"""
	excluded_ids = _OCR_SETTINGS["ignored_ids"]
	business_code = None
	for row in header_rows:
		norm_tokens = [t.lower().replace(":", "").replace(".", "").strip() for t, _ in row]
		for i, nt in enumerate(norm_tokens):
			if re.match(
				r"(?:imk|im|įm|imones|imoneskodas|imonės|imonėskodas|įmonės|įmonėskodas|įmones|įmoneskodas|įmonės kodas|imonės kodas|imkodas)",
				nt,
			):
				# Search next few tokens for digits
				for j in range(i + 1, min(i + 5, len(row))):
					cand = row[j][0]
					if re.match(r"^\d{7,12}$", cand) and cand not in excluded_ids:
						business_code = cand
						break
			if business_code:
				break
		if business_code:
			break
	return business_code


def extract_vat_code(header_joined: str, full_text: str) -> str | None:
	"""
	Extract Lithuanian VAT tax code from document text
	"""
	candidates = []
	excluded_ids = _OCR_SETTINGS["ignored_ids"]
	header_vat_codes = re.findall(REGEX_PATTERNS["vat_code"], header_joined)
	candidates = [c for c in header_vat_codes if c not in excluded_ids]

	if not candidates:
		doc_vat_codes = re.findall(REGEX_PATTERNS["vat_code"], full_text)
		candidates = [c for c in doc_vat_codes if c not in excluded_ids]

	# Deduplicate preserving order
	seen = set()
	candidates = [c for c in candidates if not (c in seen or seen.add(c))]

	return candidates[0] if candidates else None


def extract_due_date(text: str) -> str | None:
	due_date_match = re.search(REGEX_PATTERNS["due_date"], text, re.IGNORECASE)
	return due_date_match.group(1) if due_date_match else None


def extract_invoice_date(header_joined: str, due_date=None, freshness_days: int = 30) -> str:
	"""
	Date patterns (various formats: yyyy-mm-dd, dd.mm.yyyy, yyyy.mm.dd, dd/mm/yyyy)
	Additionally handle Lithuanian "YYYY m. <month_name> DD d." formats (e.g., "2024 m. liepos 26 d.")
	"""
	if due_date:
		try:
			due_date = datetime.strptime(due_date, "%Y-%m-%d").date()
		except ValueError:
			due_date = None
	# Lithuanian month names (genitive and nominative)
	lt_months = {
		"sausio": 1,
		"vasario": 2,
		"kovo": 3,
		"balandžio": 4,
		"gegužės": 5,
		"birželio": 6,
		"liepos": 7,
		"rugpjūčio": 8,
		"rugsėjo": 9,
		"spalio": 10,
		"lapkričio": 11,
		"gruodžio": 12,
		"sausis": 1,
		"vasaris": 2,
		"kovas": 3,
		"balandis": 4,
		"gegužė": 5,
		"birželis": 6,
		"liepa": 7,
		"rugpjūtis": 8,
		"rugsėjis": 9,
		"spalis": 10,
		"lapkritis": 11,
		"gruodis": 12,
	}

	# First, try to match the LT month name pattern across whitespace/newlines
	found_candidates = []  # list of date objects
	for y, mname, d in re.findall(REGEX_PATTERNS["lt_month_name"], header_joined, flags=re.IGNORECASE):
		mnum = lt_months.get(mname.lower())  # normalize
		if mnum:
			try:
				dt = date(int(y), int(mnum), int(d))
				ds = dt.strftime("%Y-%m-%d")
				if ds != due_date and dt not in found_candidates:
					found_candidates.append(dt)
			except ValueError:
				pass

	date_patterns = [
		REGEX_PATTERNS["date_yyyy_mm_dd"],
		REGEX_PATTERNS["date_dd_mm_yyyy"],
	]
	for dp in date_patterns:
		matches = re.findall(dp, header_joined)
		for m in matches:
			if isinstance(m, tuple):
				date_str = ".".join(m) if len(m) > 2 else ".".join(m)
			else:
				date_str = m

			# Try to parse date
			dt_obj = None
			for fmt in ["%Y-%m-%d", "%Y.%m.%d", "%Y/%m/%d", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%Y"]:
				try:
					dt_obj = datetime.strptime(date_str, fmt).date()
					break
				except ValueError:
					continue

			# Deduplicate if found
			if dt_obj and date_str != due_date and dt_obj not in found_candidates:
				found_candidates.append(dt_obj)

	# Apply freshness filter
	# if found_candidates:
	#     cutoff = date.today() - timedelta(days=freshness_days)
	#     found_candidates = [c for c in found_candidates if c >= cutoff]
	logger.debug(f" Invoice date candidates found: {[c.strftime('%Y-%m-%d') for c in found_candidates]}")
	return found_candidates[0].strftime("%Y-%m-%d") if found_candidates else None


def extract_all_local(texts: list, coordinates: list) -> dict:
	"""
	Extract all available data using local methods.

	Args:
	    texts: List of text strings extracted from the document
	    coordinates: List of corresponding bounding box coordinates

	Returns:
	    Dictionary with extracted fields
	"""

	invoice_data = {
		"items": [],
		"vat_amount": None,
		"total": None,
		"subtotal": None,
		"bill_date": None,
		"bill_no": None,
		"supplier_vat": None,
		"supplier_id": None,
		"due_date": None,
	}

	invoice_data.update(extract_totals(texts, coordinates))
	invoice_data.update(extract_re_barcodes(texts))

	# Join all text for regex search
	full_text = "\n".join(texts)
	rows = group_text_by_rows(texts, coordinates)

	# Consider only top portion as header region
	header_rows = rows[:HEADER_ROWS_LIMIT]
	header_texts = [" ".join(t for t, _ in r) for r in header_rows]
	header_joined = "\n".join(header_texts)

	invoice_data["due_date"] = extract_due_date(full_text)
	invoice_data["bill_date"] = extract_invoice_date(header_joined, invoice_data["due_date"])
	invoice_data["supplier_vat"] = extract_vat_code(header_joined, full_text)
	invoice_data["supplier_id"] = extract_business_id(header_rows)
	invoice_data["bill_no"] = extract_invoice_number(header_joined)
	return invoice_data


def extract_text_and_boxes(image: Image) -> tuple:
	"""Extract text and bounding boxes from image using OCR"""
	logger.debug("Extracting text and coordinates from image using OCR...")

	# Get OCR data with coordinates
	try:
		# Try with configured language(s)
		ocr_data = pytesseract.image_to_data(
			image,
			lang=OCR_LANG,
			config=OCR_CONFIG,
			output_type=pytesseract.Output.DICT,
		)
	except Exception as e:
		# Fallback to English-only if target lang is missing
		logger.debug(f"Warning: OCR with lang '{OCR_LANG}' failed ({e}). Falling back to 'eng'.")
		ocr_data = pytesseract.image_to_data(
			image,
			lang="eng",
			config=OCR_CONFIG,
			output_type=pytesseract.Output.DICT,
		)

	texts = []
	boxes = []  # Normalized
	coordinates = []  # Original

	for i in range(len(ocr_data["text"])):
		text = ocr_data["text"][i].strip()
		if text:  # Only include non-empty text
			texts.append(text)
			# Store original coordinates for grouping
			x0 = ocr_data["left"][i]
			y0 = ocr_data["top"][i]
			x1 = x0 + ocr_data["width"][i]
			y1 = y0 + ocr_data["height"][i]

			# Normalize bounding box to 0-1000 range (ML convention)
			# width = image.width
			# height = image.height
			# norm_box = [
			#     int(1000 * x0 / width),
			#     int(1000 * y0 / height),
			#     int(1000 * x1 / width),
			#     int(1000 * y1 / height),
			# ]
			box = (x0, y0, x1, y1)

			# boxes.append(norm_box)
			coordinates.append(box)

	return texts, boxes, coordinates


def group_text_by_rows(texts: list, coordinates: list, row_threshold: int = ROW_THRESHOLD) -> list:
	"""Group OCR text elements into rows based on Y coordinates"""
	if not texts or not coordinates:
		return []

	# Create list of (text, y_position)
	items = list(zip(texts, coordinates, strict=True))

	# Sort by Y position (top to bottom)
	items.sort(key=lambda x: x[1][1])  # Sort by y_top

	rows = []
	current_row = []
	current_y = None

	for text, coord in items:
		y_top = coord[1]

		# Start new row if Y position differs significantly
		if current_y is None or abs(y_top - current_y) > row_threshold:
			if current_row:
				rows.append(current_row)
			current_row = [(text, coord)]
			current_y = y_top
		else:
			current_row.append((text, coord))

	if current_row:
		rows.append(current_row)

	for row in rows:
		row.sort(key=lambda x: x[1][0])  # Sort by x_left within the row

	return rows


def pdf_to_images(pdf_path: str) -> list:
	"""Convert PDF file to images"""
	logger.debug(f"Converting PDF to images: {pdf_path}")
	# Slightly higher DPI improves OCR accuracy
	# NEED TO DOUBLE CHECK ON SCANNER SETTINGS, I feel like we do 200 DPI scans for quality/speed tradeoff
	images = convert_from_path(pdf_path, dpi=300)
	return images


def process_invoice(pdf_path: str) -> dict:
	"""Main function to process invoice PDF and extract structured data"""
	# Verify file exists
	if not os.path.exists(pdf_path):
		logger.debug(f"Error: File not found - {pdf_path}")
		return None

	# Convert PDF to images
	images = pdf_to_images(pdf_path)

	if not images:
		logger.debug("Error: Could not convert PDF to images")
		return None

	logger.debug(f"PDF converted to {len(images)} image(s)")

	# Only first page for header extraction
	# ! A pitfall for totals!
	# TODO: NEEDS TO BE CHANGED
	first_image = images[0]

	# Extract text and bounding boxes
	texts, boxes, coordinates = extract_text_and_boxes(first_image)

	# Parse invoice data with coordinate-based grouping
	invoice_data = extract_all_local(texts, coordinates)

	return invoice_data
