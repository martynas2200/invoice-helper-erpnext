import frappe

app_name = "invoice_helper"
app_title = "Invoice Helper"
app_publisher = "Martynas Miliauskas"
app_description = "Manage uploads easier with a queue, and uses some APIs to help prefill the user the data."
app_email = "martin@ekranas.info"
app_license = "mit"

# Apps
# ------------------

# required_apps = []

# Each item in the list will be shown as an app in the apps page
# add_to_apps_screen = [
# 	{
# 		"name": "invoice_helper_lt",
# 		"logo": "/assets/invoice_helper_lt/logo.png",
# 		"title": "Invoice Helper",
# 		"route": "/invoice_helper_lt",
# 		"has_permission": "invoice_helper_lt.api.permission.has_app_permission"
# 	}
# ]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
app_include_css = "/assets/invoice_helper/css/drawer.css"
app_include_js = [
	"/assets/invoice_helper/js/pending_file_drawer.js",
	"/assets/invoice_helper/js/prefill_dialog.js",
	"/assets/invoice_helper/js/split_dialog.js",
	"/assets/invoice_helper/js/move_dialog.js",
]

# include js, css files in header of web template
# web_include_css = "/assets/invoice_helper_lt/css/invoice_helper_lt.css"
# web_include_js = "/assets/invoice_helper_lt/js/invoice_helper_lt.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "invoice_helper_lt/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
doctype_js = {
	"Purchase Invoice": "public/js/purchase_invoice.js",
	"Sales Invoice": "public/js/sales_invoice.js",
	"File": "public/js/file.js",
}

# add custom actions on list view
doctype_list_js = {
	"Pending Document": "invoice_helper/doctype/pending_document/pending_document_list.js",
}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
# app_include_icons = "invoice_helper_lt/public/icons.svg"

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# automatically load and sync documents of this doctype from downstream apps
# importable_doctypes = [doctype_1]

# Jinja
# ----------

# add methods and filters to jinja environment
# jinja = {
# 	"methods": "invoice_helper_lt.utils.jinja_methods",
# 	"filters": "invoice_helper_lt.utils.jinja_filters"
# }

# Installation
# ------------

# before_install = "invoice_helper_lt.install.before_install"
# after_install = "invoice_helper_lt.install.after_install"

# Uninstallation
# ------------

# before_uninstall = "invoice_helper_lt.uninstall.before_uninstall"
# after_uninstall = "invoice_helper_lt.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "invoice_helper_lt.utils.before_app_install"
# after_app_install = "invoice_helper_lt.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "invoice_helper_lt.utils.before_app_uninstall"
# after_app_uninstall = "invoice_helper_lt.utils.after_app_uninstall"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "invoice_helper_lt.notifications.get_notification_config"

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# Document Events
# ---------------
# Hook on document methods and events

doc_events = {"Pending Document": {"after_insert": "invoice_helper.hooks.enqueue_extraction_task"}}

# Scheduled Tasks
# ---------------

# scheduler_events = {
# 	"all": [
# 		"invoice_helper_lt.tasks.all"
# 	],
# 	"daily": [
# 		"invoice_helper_lt.tasks.daily"
# 	],
# 	"hourly": [
# 		"invoice_helper_lt.tasks.hourly"
# 	],
# 	"weekly": [
# 		"invoice_helper_lt.tasks.weekly"
# 	],
# 	"monthly": [
# 		"invoice_helper_lt.tasks.monthly"
# 	],
# }

# Testing
# -------

# before_tests = "invoice_helper_lt.install.before_tests"

# Extend DocType Class
# ------------------------------
#
# Specify custom mixins to extend the standard doctype controller.
# extend_doctype_class = {
# 	"Task": "invoice_helper_lt.custom.task.CustomTaskMixin"
# }

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "invoice_helper_lt.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "invoice_helper_lt.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["invoice_helper_lt.utils.before_request"]
# after_request = ["invoice_helper_lt.utils.after_request"]

# Job Events
# ----------
# before_job = ["invoice_helper_lt.utils.before_job"]
# after_job = ["invoice_helper_lt.utils.after_job"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"invoice_helper_lt.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
# export_python_type_annotations = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }

# Translation
# ------------
# List of apps whose translatable strings should be excluded from this app's translations.
# ignore_translatable_strings_from = []


# Document Event Handlers
# -------------------------


def enqueue_extraction_task(doc, method):
	"""
	Enqueue extraction task when a new Pending Document is inserted.

	This function is called as an after_insert hook for Pending Document.
	It enqueues a background task to extract data from the document.

	Args:
		doc: The Pending Document instance
		method: The method name (not used here)
	"""
	frappe.enqueue(
		"invoice_helper.tasks.extract_document",
		doc_name=doc.name,
		queue="default",
		timeout=1800,
	)
