import { createApp } from "vue";
import UnmatchedItemsModal from "./UnmatchedItemsModal.vue";

frappe.ui.UnmatchedItemsModal = UnmatchedItemsModal;

frappe.ui.mountUnmatchedItemsModal = (element, props) => {
    const app = createApp(UnmatchedItemsModal, props);
    app.config.globalProperties.__ = window.__;
    app.config.globalProperties.frappe = window.frappe;
    app.mount(element);
    return app;
};
