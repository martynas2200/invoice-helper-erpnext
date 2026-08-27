# Invoice Helper

**NOTE: The app is in early development. Aimed for using for lithuanian invoices for now.**

Invoice Helper is a document extraction helper built on Frappe that semi-automates invoice data extraction from PDFs. It leverages local OCR (Tesseract) and Amazon Textract to extract key invoice fields.

## Core Functionality
- Pending Document List: Queue-based workflow for tracking and processing uploaded invoices;
- File upload endpoint (`/api/method/invoice_helper_lt.api.upload_pending_document`): which can be used to upload documents via API calls;
- File Drawer: UI component to view uploaded document when filling in invoice form
- Document Processing Pipeline: Extracts invoice data using local OCR (Tesseract) and Amazon Textract;
- Party Matching: Automatically finds and links Suppliers/Customers based on Lithuanian tax codes and business IDs;
- Background Task Processing: Handles asynchronous extraction of pending documents;
- Textract Integration: User manually specifies which columns contain barcode, quantity, and price.
- Tabula Support: Local table extraction available for only slightly tilted pages, though not fine-tuned. Requires a Java Runtime Environment (JRE) to be installed on the host.


## TODOs / Future Enhancements
- [ ] More robust VAT amount extraction
- [ ] Doctypes `Supplier`, `Customer` needs to have `business_code` field for party matching to work, so installation needs to create these fields if not present automatically.
- [ ] Introduce a re setting, so a user can change the expected tax ID format per country
- [ ] Date extraction robustness + compile a test corpus
- [ ] Consider bringing in the line extraction OCR, and only suggest the user to use it if the totals completely match.
- [ ] Dialog of prefill could be improved to show available options better (as in how many candidates or so)


### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI:

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app https://github.com/martynas2200/invoice-helper-erpnext --branch develop
bench install-app invoice_helper
```

This app relies on a few system-level tools for PDF/OCR/table processing. Make sure these are installed and
available in the `PATH` of the machine or container running Frappe:

- Poppler utilities (for `pdf2image`, e.g. `pdftoppm`)
- Tesseract OCR (for local OCR extraction)
- Optional: Java Runtime Environment / JDK (for `tabula-py` table extraction)

For example:

- macOS (Homebrew): `brew install poppler tesseract openjdk`
- Debian/Ubuntu: `apt-get update && apt-get install -y poppler-utils tesseract-ocr default-jre-headless`

### Contributing

This app uses `pre-commit` for code formatting and linting. Please [install pre-commit](https://pre-commit.com/#installation) and enable it for this repository:

```bash
cd apps/invoice_helper
pre-commit install
```

Pre-commit is configured to use the following tools for checking and formatting your code:

- ruff
- eslint
- prettier
- pyupgrade

### License

mit
