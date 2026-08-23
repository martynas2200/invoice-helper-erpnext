import json
import re
import unicodedata
from datetime import datetime
from difflib import SequenceMatcher

import frappe
from frappe.core.api.file import create_new_folder
from frappe.share import add_docshare


def get_or_create_folder(folder_path: str) -> str:
	"""Get or create a folder by path using Frappe's File model.

	The returned value is the *name* of the final File folder document,
	which in practice is the full folder path (e.g. "Home/2025/11").
	"""
	parts = [p for p in folder_path.split("/") if p]
	if not parts:
		frappe.throw("Invalid folder path")

	# Ensure root folder exists (e.g. "Home").
	current_name = parts[0]
	if not frappe.db.exists("File", {"name": current_name, "is_folder": 1}):
		frappe.get_doc({"doctype": "File", "file_name": current_name, "is_folder": 1}).insert(
			ignore_if_duplicate=True, ignore_permissions=True
		)

	# Create intermediate folders under the current parent as needed.
	for part in parts[1:]:
		existing = frappe.get_all(
			"File",
			filters={"file_name": part, "folder": current_name, "is_folder": 1},
			fields=["name"],
			limit=1,
		)
		if existing:
			current_name = existing[0].name
			continue

		folder_doc = create_new_folder(part, current_name)
		current_name = folder_doc.name

	return current_name


def get_year_month_folder() -> str:
	"""Get or create a folder for current year/month.

	Returns folder path like "Home/2025/11"
	"""
	now = datetime.now()
	year = str(now.year)
	month = str(now.month).zfill(2)  # Pad with zero: 01, 02, ..., 12

	folder_path = f"Home/{year}/{month}"
	return get_or_create_folder(folder_path)


@frappe.whitelist(methods=["POST"], allow_guest=False)
def upload_pending_document() -> dict:
	"""Upload a file and create a linked Pending Document.

	Request should be multipart/form-data with a 'file' field.
	Files are organized into Home/YYYY/MM folders automatically.
	"""
	uploaded = getattr(frappe.request, "files", {}).get("file")  # type: ignore[attr-defined]
	if not uploaded:
		frappe.throw("No file provided. Send multipart/form-data with field 'file'.")

	file_name = getattr(uploaded, "filename", None) or frappe.form_dict.get("file_name")

	# Check size BEFORE reading the entire file
	content_length = uploaded.content_length
	if content_length and content_length > 10 * 1024 * 1024:
		frappe.throw("File size exceeds 10 MB limit")

	content = uploaded.read() if hasattr(uploaded, "read") else uploaded.stream.read()

	if not content:
		frappe.throw("Uploaded file is empty")

	# Get or create year/month folder
	folder = get_year_month_folder()

	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": file_name,
			"is_private": 1,
			"content": content,
			"folder": folder,
		}
	).insert(ignore_permissions=True)

	pending = frappe.get_doc(
		{
			"doctype": "Pending Document",
			"file": file_doc.name,
			"status": "Pending",
			"document_name": file_name,
			"party_type": "Supplier",
		}
	).insert(ignore_permissions=True)

	# Attach the file to the Pending Document so its permissions
	# follow the document's permissions (required for downloads).
	# NOTE: /home/frappe/frappe-bench/apps/frappe/frappe/utils/response.py download_private_file blocks access otherwise. Might need to remove the second check if we want all logged-in users to access.
	file_doc.attached_to_doctype = "Pending Document"
	file_doc.attached_to_name = pending.name
	file_doc.attached_to_field = "file"
	file_doc.save(ignore_permissions=True)

	# Attach a comment if the file size is above 5 MB
	if content_length and content_length > 5 * 1024 * 1024:
		pending.add_comment("Info", "Large file uploaded (>5 MB). Processing might take longer than usual.")

	return {
		"name": pending.name,
		"file_url": file_doc.file_url,
		"file_name": file_doc.file_name,
		"status": pending.status,
		"document_name": pending.get("document_name"),
		"party_type": pending.get("party_type"),
		"party": pending.get("party"),
	}


@frappe.whitelist()
def create_pending_from_file(
	file: str | None = None,
	file_url: str | None = None,
	type: str | None = None,
	document_name: str | None = None,
) -> dict:
	"""Create a Pending Document from an existing File document or file_url.

	Args can be provided either 'file' (File.name) or 'file_url'.
	"""
	file_doc = None
	if file:
		file_doc = frappe.get_doc("File", file)
	elif file_url:
		file_doc = frappe.get_all(
			"File", filters={"file_url": file_url}, fields=["name", "file_name"], limit=1
		)
		if not file_doc:
			frappe.throw("File with given file_url not found")
		file_doc = frappe.get_doc("File", file_doc[0].name)
	else:
		frappe.throw("Please specify either 'file' or 'file_url'")

	if document_name is None:
		document_name = file_doc.file_name

	pending = frappe.get_doc(
		{
			"doctype": "Pending Document",
			"file": file_doc.name,
			"type": (type or "Other").title(),
			"status": "Pending",
			"document_name": document_name,
		}
	).insert()

	# Attach the file to the Pending Document so its permissions follow the document's permissions.
	file_doc.attached_to_doctype = "Pending Document"
	file_doc.attached_to_name = pending.name
	file_doc.attached_to_field = "file"
	file_doc.save(ignore_permissions=True)

	return {"name": pending.name}


@frappe.whitelist()
def get_item_codes_for_barcodes(barcodes):
	"""Map barcodes to item codes using Item Barcode master.

	Args:
	    barcodes: List of barcode strings to lookup (can be list or JSON string)

	Returns:
	    Dictionary mapping barcode -> item_code
	"""
	if not barcodes:
		return {}

	if isinstance(barcodes, str):
		try:
			barcodes = json.loads(barcodes)
		except (json.JSONDecodeError, TypeError):
			barcodes = [barcodes]

	# Ensure it's a list
	if not isinstance(barcodes, list):
		barcodes = [barcodes]

	item_barcodes = frappe.get_all(
		"Item Barcode",
		filters={"barcode": ["in", barcodes]},
		fields=["barcode", "parent", "uom"],
	)

	mapping = {}
	# TODO: a single SQL query would be more efficient
	for item_barcode in item_barcodes:
		mapping[item_barcode.barcode] = {
			"item_code": item_barcode.parent,
			"item_name": frappe.db.get_value("Item", item_barcode.parent, "item_name"),
			"uom": item_barcode.uom or frappe.db.get_value("Item", item_barcode.parent, "stock_uom"),
		}

	return mapping


@frappe.whitelist()
def get_item_details_for_prefill(doc, rows):
	"""Batch item-details fetch for the prefill dialog.

	Mirrors what ERPNext's client-side handler does (process_item_selection) but
	runs `get_item_details` once per row on the server.

	Args:
	    doc: parent document dict (the unsaved frm.doc)
	    rows: [{"row_index": int, "item_code": str, "qty": float|None,
	            "uom": str|None, "rate": float|None}]

	Returns:
	    [{"row_index": int, "item_code": str, "details": dict|None,
	      "error": str|None}]
	"""

	from erpnext.stock.get_item_details import get_item_details
	from frappe.utils import flt

	# Over HTTP, `frappe.call` serializes dict args as JSON strings, so both
	# `doc` and `rows` may arrive as strings and need decoding first.
	if isinstance(doc, str):
		doc = json.loads(doc)
	if isinstance(rows, str):
		rows = json.loads(rows)

	parent = frappe._dict(doc or {})

	results = []
	for row in rows or []:
		row = frappe._dict(row or {})
		item_code = (row.get("item_code") or "").strip()

		if not item_code:
			results.append(
				{
					"row_index": row.get("row_index"),
					"item_code": None,
					"details": None,
					"error": None,
				}
			)
			continue

		try:
			ctx = frappe._dict(
				{
					"item_code": item_code,
					"barcode": None,
					"serial_no": None,
					"batch_no": None,
					"qty": flt(row.get("qty")) or 1,
					"uom": row.get("uom") or None,
					"rate": flt(row.get("rate")) or 0,
					"net_rate": flt(row.get("rate")) or 0,
					"warehouse": row.get("warehouse") or parent.get("set_warehouse"),
					"set_warehouse": parent.get("set_warehouse"),
					"customer": parent.get("customer"),
					"supplier": parent.get("supplier"),
					"currency": parent.get("currency"),
					"conversion_rate": parent.get("conversion_rate"),
					"price_list": parent.get("buying_price_list") or parent.get("selling_price_list"),
					"price_list_currency": parent.get("price_list_currency"),
					"plc_conversion_rate": parent.get("plc_conversion_rate"),
					"company": parent.get("company"),
					"doctype": parent.get("doctype"),
					"parenttype": parent.get("doctype"),
					"name": parent.get("name") or "",
					"child_doctype": f"{parent.get('doctype')} Item",
					"child_docname": "",
					"transaction_date": parent.get("transaction_date") or parent.get("posting_date"),
					"is_subcontracted": parent.get("is_subcontracted"),
					"is_internal_supplier": parent.get("is_internal_supplier"),
					"is_internal_customer": parent.get("is_internal_customer"),
					"update_stock": parent.get("update_stock") or 0,
					"is_return": parent.get("is_return") or 0,
					"is_pos": parent.get("is_pos") or 0,
					"pos_profile": parent.get("pos_profile"),
					"ignore_pricing_rule": parent.get("ignore_pricing_rule"),
					"tax_category": parent.get("tax_category"),
					"item_tax_template": None,
					"project": parent.get("project"),
					"cost_center": None,
					"stock_uom": None,
					"stock_qty": None,
					"conversion_factor": None,
					"weight_per_unit": None,
					"weight_uom": None,
					"manufacturer": None,
					"use_serial_batch_fields": None,
					"serial_and_batch_bundle": None,
					"order_type": parent.get("order_type"),
				}
			)

			details = get_item_details(ctx, doc=parent)

			# Replicate what the client-side `apply_price_list` and rate handlers do
			if not flt(details.get("rate")):
				details.rate = flt(details.get("price_list_rate"))
			if not flt(details.get("amount")) and flt(details.qty):
				details.amount = flt(details.qty) * flt(details.rate)

			results.append(
				{
					"row_index": row.get("row_index"),
					"item_code": item_code,
					"details": details,
					"error": None,
				}
			)
		except Exception as exc:
			frappe.log_error(
				title="invoice_helper: get_item_details_for_prefill",
				message=frappe.get_traceback(),
			)
			results.append(
				{
					"row_index": row.get("row_index"),
					"item_code": item_code,
					"details": None,
					"error": str(exc),
				}
			)

	return results


def _normalize_for_item_search(value: str | None) -> str:
	text = (value or "").strip().lower()
	if not text:
		return ""

	decomposed = unicodedata.normalize("NFKD", text)
	no_diacritics = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
	return re.sub(r"[^\w\s%]", " ", no_diacritics)


def _tokenize_for_item_search(value: str | None) -> list[str]:
	normalized = _normalize_for_item_search(value)
	if not normalized:
		return []

	stop_words = {
		"eur",
		"suma",
		"pvm",
		"tar",
		"vnt",
		"vntpvm",
		# "but",
		# "sk",
		# "pet",
		"pak",
		"ml",
		"l",
		"kg",
		"x",
		"xx",
		"nt",
		"ir",
		"su",
		"be",
	}

	tokens = []
	for token in normalized.split():
		if len(token) < 2:
			continue
		if token in stop_words:
			continue
		# TODO: Would be ideal to agree what patters we use in our own names, so then we can convert 0.5L or 500ml to a consistent format before matching.
		# NOTE: we might just ignore these tokens as they are often noisy
		# if re.fullmatch(r"\d+(?:[.,]\d+)?%?", token):
		# 	continue
		tokens.append(token)

	return list(dict.fromkeys(tokens))


def _detect_brands_from_title(
	query_tokens: list[str], normalized_title: str, max_results: int = 3
) -> list[str]:
	if not query_tokens or not normalized_title:
		return []

	try:
		brands = frappe.get_all("Brand", fields=["name"], limit_page_length=2000)
	except Exception:
		return []

	if not brands:
		return []

	token_set = set(query_tokens)
	scored = []
	padded_title = f" {normalized_title} "

	for row in brands:
		brand_name = (row.get("name") or "").strip()
		if not brand_name:
			continue

		normalized_brand = _normalize_for_item_search(brand_name)
		if not normalized_brand:
			continue

		brand_tokens = [token for token in normalized_brand.split() if len(token) >= 2]
		if not brand_tokens:
			continue

		score = 0.0
		if f" {normalized_brand} " in padded_title:
			score += 5.0

		overlap_count = 0
		for brand_token in brand_tokens:
			if brand_token in token_set:
				score += 3.0
				overlap_count += 1
			elif any(
				(len(token) >= 3 and (brand_token.startswith(token) or token.startswith(brand_token)))
				for token in token_set
			):
				score += 1.0

		if score <= 0:
			continue

		score += overlap_count / max(len(brand_tokens), 1)
		scored.append((score, brand_name))

	scored.sort(key=lambda value: value[0], reverse=True)
	result = []
	for _, brand in scored:
		if brand in result:
			continue
		result.append(brand)
		if len(result) >= max_results:
			break

	return result


@frappe.whitelist()
def recommend_items_for_title(title=None, max_results=8):
	"""Return ranked Item suggestions for noisy extracted invoice titles.

	Args:
	    title: Extracted title text from invoice row.
	    max_results: Max number of recommended rows to return (default 8).

	Returns:
	    List of ranked suggestions with item_code, item_name, stock_uom and score.
	"""
	if not title:
		return []

	try:
		max_results = int(max_results or 8)
	except (TypeError, ValueError):
		max_results = 8

	max_results = min(max(max_results, 1), 20)

	query_tokens = _tokenize_for_item_search(title)
	if not query_tokens:
		return []

	normalized_query = _normalize_for_item_search(title)
	if not normalized_query:
		return []

	item_fields = ["name", "item_code", "item_name", "stock_uom", "item_group", "brand"]

	detected_brands = _detect_brands_from_title(query_tokens, normalized_query, max_results=3)
	brand_rank = {brand: idx for idx, brand in enumerate(detected_brands)}

	candidates = []
	if detected_brands:
		candidates = frappe.get_all(
			"Item",
			filters={"disabled": 0, "brand": ["in", detected_brands]},
			fields=item_fields,
			limit=300,
			order_by="modified desc",
		)

	or_filters = []
	for token in query_tokens[:6]:
		or_filters.append(["item_name", "like", f"%{token}%"])

	fallback_candidates = frappe.get_all(
		"Item",
		filters={"disabled": 0},
		or_filters=or_filters,
		fields=item_fields,
		limit=220,
		order_by="modified desc",
	)

	# If brand was detected, keep brand matches as primary set and fill remaining slots with fallback rows.
	if detected_brands:
		known_names = {row.get("name") for row in candidates if row.get("name")}
		for row in fallback_candidates:
			row_name = row.get("name")
			if row_name and row_name in known_names:
				continue
			candidates.append(row)
			if len(candidates) >= 350:
				break
	else:
		candidates = fallback_candidates

	if not candidates:
		return []

	token_doc_freq = {token: 0 for token in query_tokens}
	group_likelihood = {}
	for row in candidates:
		candidate_text = _normalize_for_item_search(row.get("item_name") or "")
		hit_count = 0
		for token in query_tokens:
			if token in candidate_text:
				token_doc_freq[token] += 1
				hit_count += 1

		item_group = row.get("item_group")
		if item_group and hit_count:
			group_likelihood[item_group] = group_likelihood.get(item_group, 0.0) + hit_count

	ranked = []
	candidate_count = len(candidates)
	for row in candidates:
		item_name = row.get("item_name") or ""
		item_code = row.get("item_code") or row.get("name")
		item_brand = row.get("brand")
		item_group = row.get("item_group")
		candidate_text = _normalize_for_item_search(item_name)

		token_score = 0.0
		matched_tokens = []
		for token in query_tokens:
			if token in candidate_text:
				matched_tokens.append(token)
				freq = token_doc_freq[token] or 1
				weight = 1.0 + (1.0 - (freq / candidate_count)) * 2.0
				token_score += weight

		if not matched_tokens:
			continue

		name_similarity = SequenceMatcher(
			None, normalized_query, _normalize_for_item_search(item_name)
		).ratio()
		full_similarity = SequenceMatcher(None, normalized_query, candidate_text).ratio()
		coverage = len(matched_tokens) / max(len(query_tokens), 1)

		brand_bonus = 0.0
		if detected_brands and item_brand in brand_rank:
			# Earlier brand matches are stronger.
			brand_bonus = 3.0 - (brand_rank[item_brand] * 0.6)

		group_bonus = 0.0
		if item_group:
			normalized_group = _normalize_for_item_search(item_group)
			group_token_hits = sum(1 for token in query_tokens if token in normalized_group)
			group_bonus += group_token_hits * 0.8
			group_bonus += min((group_likelihood.get(item_group, 0.0) / max(candidate_count, 1)) * 2.0, 1.4)

		score = (
			token_score
			+ (coverage * 3.0)
			+ (name_similarity * 2.5)
			+ full_similarity
			+ brand_bonus
			+ group_bonus
		)
		ranked.append(
			{
				"item_code": item_code,
				"item_name": item_name,
				"stock_uom": row.get("stock_uom"),
				"brand": item_brand,
				"item_group": item_group,
				"score": round(score, 4),
				"matched_tokens": matched_tokens,
			}
		)

	ranked.sort(key=lambda d: d.get("score", 0), reverse=True)
	return ranked[:max_results]


@frappe.whitelist()
def recommend_items_for_partial_barcode(barcode=None, max_results=10):
	"""Return Item suggestions where Item Barcode contains the provided barcode fragment."""
	barcode_text = re.sub(r"\D", "", str(barcode or "").strip())
	if not barcode_text:
		return []

	try:
		max_results = int(max_results or 10)
	except (TypeError, ValueError):
		max_results = 10

	max_results = min(max(max_results, 1), 50)

	barcode_rows = frappe.get_all(
		"Item Barcode",
		filters=[["barcode", "like", f"%{barcode_text}%"]],
		fields=["parent", "barcode", "uom"],
		limit=500,
	)
	if not barcode_rows:
		return []

	item_codes = list(dict.fromkeys([row.parent for row in barcode_rows if row.parent]))
	if not item_codes:
		return []

	items = frappe.get_all(
		"Item",
		filters={"name": ["in", item_codes], "disabled": 0},
		fields=["name", "item_code", "item_name", "stock_uom"],
	)
	if not items:
		return []

	rows_by_item = {}
	for row in barcode_rows:
		if not row.parent:
			continue
		rows_by_item.setdefault(row.parent, []).append(row)

	recommendations = []
	for item in items:
		item_code = item.get("item_code") or item.get("name")
		item_rows = rows_by_item.get(item.get("name"), [])
		if not item_rows:
			continue

		best_score = 0.0
		best_barcode = None
		for barcode_row in item_rows:
			candidate = str(barcode_row.get("barcode") or "")
			if not candidate:
				continue

			score = len(barcode_text) / max(len(candidate), 1)
			if candidate == barcode_text:
				score += 3.0
			elif candidate.startswith(barcode_text) or candidate.endswith(barcode_text):
				score += 1.5

			if score > best_score:
				best_score = score
				best_barcode = candidate

		recommendations.append(
			{
				"item_code": item_code,
				"item_name": item.get("item_name"),
				"stock_uom": item.get("stock_uom"),
				"score": round(best_score, 4),
				"matched_barcode": best_barcode,
			}
		)

	recommendations.sort(key=lambda d: d.get("score", 0), reverse=True)
	return recommendations[:max_results]
