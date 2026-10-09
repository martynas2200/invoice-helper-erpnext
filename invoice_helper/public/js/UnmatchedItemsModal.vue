<template>
    <div v-if="isOpen" class="invoice-helper-modal-overlay">
        <div class="invoice-helper-modal modal-content">
            <div class="modal-header">
                <h4 class="modal-title">
                    {{ __("Unmatched Row {0} of {1}", [currentIndex + 1, rows.length]) }}
                </h4>
                <button type="button" class="btn btn-link btn-modal-close" @click="close">
                    <svg class="icon icon-sm" aria-hidden="true">
                        <use data-v-cea3ffc8="" class="close-alt" href="#icon-close-alt"></use>
                    </svg>
                </button>
            </div>
            <div class="modal-body">
                <div class="mb3">
                    <strong>{{ __("Source row") }}: {{ rowNumber + 1 }}</strong>
                    <table
                        v-if="allColumns.length"
                        class="table table-bordered table-condensed mt-2"
                    >
                        <tbody>
                            <tr v-for="(value, index) in allColumns" :key="index">
                                <th>{{ __("Column") }} {{ index + 1 }}</th>
                                <td>{{ value }}</td>
                            </tr>
                        </tbody>
                    </table>
                    <pre v-else class="invoice-helper-json-preview">{{ extractedJson }}</pre>
                </div>
                <div class="row">
                    <div class="col-sm-6 form-group">
                        <label>{{ __("Quantity") }}</label
                        ><input v-model="quantity" class="form-control" type="text" />
                    </div>
                    <div class="col-sm-6 form-group">
                        <label>{{ __("Price") }}</label
                        ><input v-model="price" class="form-control" type="text" />
                    </div>
                </div>
                <div class="invoice-helper-search-tabs">
                    <button
                        class="btn btn-sm"
                        :class="searchMode === 'name' ? 'btn-primary' : 'btn-default'"
                        @click="setSearchMode('name')"
                    >
                        {{ __("Search by name/code") }}
                    </button>
                    <button
                        class="btn btn-sm"
                        :class="searchMode === 'barcode' ? 'btn-primary' : 'btn-default'"
                        @click="setSearchMode('barcode')"
                    >
                        {{ __("Search by barcode") }}
                    </button>
                </div>
                <div class="input-group mb-3">
                    <input
                        v-model="searchQuery"
                        class="form-control mr-0"
                        type="text"
                        :placeholder="
                            searchMode === 'barcode' ? __('Barcode') : __('Item name or code')
                        "
                        @input="scheduleSearch"
                    />
                </div>
                <div v-if="statusMessage" class="text-muted mb-2">{{ statusMessage }}</div>
                <div v-if="loading" class="text-center text-muted p-3">
                    <svg class="icon icon-xl spinner-border" aria-hidden="true">
                        <use href="#icon-loader-circle" class="loader-circle"></use>
                    </svg>
                    <svg data-v-cea3ffc8="" class="icon icon-sm" aria-hidden="true">
                        <use data-v-cea3ffc8="" href="#icon-close-alt"></use>
                    </svg>
                    {{ __("Loading...") }}
                </div>
                <div v-else-if="recommendations.length" class="invoice-helper-recommendations">
                    <button
                        v-for="item in recommendations"
                        :key="item.item_code"
                        type="button"
                        class="btn btn-default invoice-helper-recommendation"
                        :class="{ 'btn-primary': selectedItem?.item_code === item.item_code }"
                        @click="selectItem(item)"
                    >
                        <span>{{ item.item_name || item.item_code }}</span>
                        <small
                            >{{ item.item_code
                            }}<span v-if="item.stock_uom"> &middot; {{ item.stock_uom }}</span
                            ><span v-if="item.matched_barcode">
                                &middot; {{ item.matched_barcode }}</span
                            ></small
                        >
                    </button>
                </div>
                <div v-else class="text-muted">{{ __("No recommendations found.") }}</div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-default" :disabled="loading || creating" @click="skip">
                    {{ __("Skip") }}
                </button>
                <button
                    class="btn btn-default"
                    :disabled="loading || creating"
                    @click="createItem"
                >
                    {{ creating ? __("Creating...") : __("Create a new item") }}
                </button>
                <button
                    class="btn btn-primary"
                    :disabled="!selectedItem || loading || creating"
                    @click="continueWithSelection"
                >
                    {{ __("Continue") }}
                </button>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: "UnmatchedItemsModal",
    props: {
        isOpen: Boolean,
        rows: { type: Array, default: () => [] },
        resolveRow: { type: Function, required: true },
        createItemForRow: { type: Function, required: true },
        finish: { type: Function, required: true },
    },
    data() {
        return {
            currentIndex: 0,
            searchMode: "name",
            searchQuery: "",
            recommendations: [],
            selectedItem: null,
            quantity: "",
            price: "",
            loading: false,
            creating: false,
            statusMessage: "",
            searchTimer: null,
            searchRequestId: 0,
        };
    },
    computed: {
        row() {
            return this.rows[this.currentIndex] || {};
        },
        rowNumber() {
            return this.row.row_index ?? this.currentIndex;
        },
        allColumns() {
            return this.row.extracted_row?.all_columns || [];
        },
        extractedJson() {
            return JSON.stringify(this.row.extracted_row || {}, null, 2);
        },
    },
    watch: {
        isOpen(value) {
            if (value) this.loadDefaultRecommendations();
        },
    },
    mounted() {
        if (this.isOpen) this.loadDefaultRecommendations();
    },
    beforeUnmount() {
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.searchRequestId++;
    },
    methods: {
        normalizeBarcode(value) {
            const normalized = String(value || "")
                .trim()
                .replace(/\D/g, "");
            return normalized || null;
        },
        parseNumeric(value) {
            const parsed = parseFloat(
                String(value ?? "")
                    .trim()
                    .replace(/\s/g, "")
                    .replace(/,/g, ".")
            );
            return Number.isNaN(parsed) ? null : parsed;
        },
        rowTitle() {
            return (
                [
                    this.row.title,
                    this.row.extracted_row?.title,
                    this.row.extracted_row?.item,
                    this.row.extracted_row?.name,
                    this.row.barcode,
                ].find((value) => String(value || "").trim()) || ""
            );
        },
        async loadDefaultRecommendations() {
            this.searchMode = "name";
            this.searchQuery = this.rowTitle();
            this.quantity =
                this.row.quantity ??
                this.row.extracted_row?.quantity ??
                this.row.extracted_row?.qty ??
                "";
            this.price =
                this.row.price ??
                this.row.extracted_row?.price ??
                this.row.extracted_row?.rate ??
                "";
            this.selectedItem = null;
            this.statusMessage = "";
            await this.search();
        },
        setSearchMode(mode) {
            this.searchMode = mode;
            this.searchQuery =
                mode === "barcode"
                    ? this.row.barcode || this.row.extracted_row?.barcode || ""
                    : this.rowTitle();
            this.selectedItem = null;
            this.statusMessage = "";
            this.scheduleSearch();
        },
        scheduleSearch() {
            if (this.searchTimer) clearTimeout(this.searchTimer);
            this.selectedItem = null;
            this.statusMessage = "";

            if (!String(this.searchQuery || "").trim()) {
                this.searchRequestId++;
                this.recommendations = [];
                this.loading = false;
                return;
            }

            this.searchTimer = setTimeout(() => {
                this.searchTimer = null;
                void this.search();
            }, 350);
        },
        async search() {
            const query = String(this.searchQuery || "").trim();
            if (!query) return;
            const requestId = ++this.searchRequestId;
            this.loading = true;
            this.statusMessage = "";
            this.selectedItem = null;
            try {
                const barcodeSearch = this.searchMode === "barcode";
                if (barcodeSearch) {
                    const exactResponse = await frappe.call({
                        method: "invoice_helper.api.get_item_codes_for_barcodes",
                        args: { barcodes: [this.normalizeBarcode(query)] },
                    });
                    const exactMatch = exactResponse?.message?.[this.normalizeBarcode(query)];
                    if (requestId !== this.searchRequestId) return;
                    if (exactMatch?.item_code) {
                        this.recommendations = [
                            {
                                ...exactMatch,
                                matched_barcode:
                                    exactMatch.matched_barcode || this.normalizeBarcode(query),
                            },
                        ];
                        this.statusMessage = __("Exact barcode match found.");
                        return;
                    }
                }
                const response = await frappe.call({
                    method: barcodeSearch
                        ? "invoice_helper.api.recommend_items_for_partial_barcode"
                        : "invoice_helper.api.recommend_items_for_title",
                    args: barcodeSearch
                        ? { barcode: this.normalizeBarcode(query), max_results: 10 }
                        : { title: query, max_results: 8 },
                });
                if (requestId !== this.searchRequestId) return;
                this.recommendations = Array.isArray(response?.message) ? response.message : [];
            } catch (error) {
                if (requestId !== this.searchRequestId) return;
                console.error("Could not load item recommendations:", error);
                this.recommendations = [];
                this.statusMessage = __("Search failed. Please try again.");
            } finally {
                if (requestId !== this.searchRequestId) return;
                this.loading = false;
            }
        },
        selectItem(item) {
            this.selectedItem = item;
            this.statusMessage = __("Selected: {0}", [item.item_code]);
        },
        async continueWithSelection() {
            if (!this.selectedItem) return;
            await this.resolveRow(
                this.row,
                this.selectedItem,
                this.normalizeBarcode(
                    this.searchMode === "barcode" ? this.searchQuery : this.row.barcode
                ),
                this.parseNumeric(this.quantity),
                this.parseNumeric(this.price)
            );
            this.nextRow();
        },
        async createItem() {
            const barcode = this.normalizeBarcode(
                this.row.barcode ||
                    this.row.extracted_row?.barcode ||
                    (this.searchMode === "barcode" ? this.searchQuery : "")
            );
            if (!barcode) {
                frappe.msgprint({
                    title: __("Invalid Barcode"),
                    message: __("Please provide a valid barcode before creating a new item."),
                    indicator: "orange",
                });
                return;
            }
            this.creating = true;
            try {
                const item = await this.createItemForRow(
                    this.row,
                    barcode,
                    this.rowTitle() || __("New Item")
                );
                await this.resolveRow(
                    this.row,
                    item,
                    barcode,
                    this.parseNumeric(this.quantity),
                    this.parseNumeric(this.price),
                    "create_item"
                );
                this.nextRow();
            } finally {
                this.creating = false;
            }
        },
        skip() {
            this.row.resolution = "ignored";
            this.nextRow();
        },
        nextRow() {
            if (this.currentIndex + 1 >= this.rows.length) {
                this.finish();
                return;
            }
            this.currentIndex += 1;
            void this.loadDefaultRecommendations();
        },
        close() {
            this.finish();
        },
    },
};
</script>

<style scoped>
.invoice-helper-modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 1050;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
}

.invoice-helper-modal {
    width: min(760px, 100%);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;

    .modal-header,
    .modal-footer {
        flex-shrink: 0;
    }

    .modal-body {
        min-height: 0;
        overflow-y: auto;
    }
}

.invoice-helper-json-preview {
    max-height: 180px;
    overflow: auto;
    margin-top: 8px;
}

.invoice-helper-search-tabs {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
}

.invoice-helper-recommendation {
    display: block;
    width: 100%;
    text-align: left;
    margin-bottom: 6px;

    small {
        display: block;
        opacity: 0.75;
        margin-top: 3px;
    }
}
/* Overwrite hover effect for selected item */
button.btn.btn-default.invoice-helper-recommendation.btn-primary {
    background: var(--btn-primary);
    color: var(--neutral);
}
</style>
