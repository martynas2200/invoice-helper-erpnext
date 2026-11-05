import { createApp } from "vue";
import UnmatchedItemsModal from "./UnmatchedItemsModal.vue";

function mount_unmatched_items_modal(element, props) {
    const app = createApp(UnmatchedItemsModal, props);

    app.config.globalProperties.__ = window.__;
    app.config.globalProperties.frappe = window.frappe;

    app.mount(element);
    return app;
}

frappe.ui.mount_unmatched_items_modal = mount_unmatched_items_modal;

export default mount_unmatched_items_modal;
