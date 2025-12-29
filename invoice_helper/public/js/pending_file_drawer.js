/**
 * Pending File Drawer
 * Shows a drawer with a preview of the pending document file
 * when frm._pending_file is set on Sale Invoice or Purchase Invoice forms.
 * Appends to Frappe's .layout-main to appear alongside the form.
 */

frappe.provide("invoice_helper");

invoice_helper.PendingFileDrawer = class PendingFileDrawer {
    constructor(frm) {
        this.frm = frm;
        this.drawer = null;
        this.file_doc = null;
        this.layout_main = null;
        this.current_width = 350; // Default width
        this.min_width = 250;
        this.max_width = Math.floor(window.innerWidth / 2); // Half of screen
        this.step = 50;
    }

    // _drawer_file is used to track if the drawer is already shown for the current pending file
    async show() {
        if (this.frm._drawer_file == this.frm._pending_file) {
            this.frm.add_custom_button(__("Show Drawer"), () => {
                this.frm._drawer_file = null;
                this.show();
            });
            return;
        } else if (!this.frm._pending_file) {
            return;
        }

        try {
            this.frm._drawer_file = this.frm._pending_file;
            this.file_doc = await frappe.db.get_doc("File", this.frm._pending_file);
            if (!this.file_doc || !this.file_doc.file_url) {
                console.warn("No file URL found for pending file:", this.frm._pending_file);
                return;
            }
            // Wait for Frappe to finish rendering the layout before adding the drawer
            await new Promise((resolve) => setTimeout(resolve, 1000));
            this._create_drawer();
        } catch (err) {
            console.error("Error loading pending file:", err);
        }
    }

    _create_drawer() {
        $(".pending-file-drawer").remove();

        const file_url = this.file_doc.file_url;
        const file_name = this.file_doc.file_name || this.file_doc.name;
        const file_ext = file_url.split(".").pop().toLowerCase();

        // Find the visible layout main (there can be multiple from cached pages)
        this.layout_main = $(".page-container:visible .layout-main");

        if (!this.layout_main.length) {
            // Fallback to any visible layout-main
            this.layout_main = $(".layout-main:visible");
        }

        if (!this.layout_main.length) {
            console.warn("Layout main not found, cannot show drawer");
            return;
        }

        // Create drawer container
        this.drawer = $(`
            <div class="pending-file-drawer">
                <div class="drawer-header">
                    <div class="drawer-title">
                        <span class="drawer-icon">
                            <svg class="icon icon-md"><use href="#icon-file"></use></svg>
                        </span>
                        <span class="drawer-filename" title="${file_name}">${file_name}</span>
                    </div>
                    <div class="drawer-actions">
                        <button class="btn btn-xs btn-default drawer-expand-btn" title="${__(
                            "Expand"
                        )}">
                            <svg class="icon icon-sm"><use href="#icon-arrow-left"></use></svg>
                        </button>
                        <button class="btn btn-xs btn-default drawer-shrink-btn" title="${__(
                            "Shrink"
                        )}">
                            <svg class="icon icon-sm"><use href="#icon-arrow-right"></use></svg>
                        </button>
                        <button class="btn btn-xs btn-default drawer-open-btn" title="${__(
                            "Open in new tab"
                        )}">
                            <svg class="icon icon-sm"><use href="#icon-external-link"></use></svg>
                        </button>
                        <button class="btn btn-xs btn-default drawer-close-btn" title="${__(
                            "Close"
                        )}">
                            <svg class="icon icon-sm"><use href="#icon-close"></use></svg>
                        </button>
                    </div>
                </div>
                <div class="drawer-content">
                    ${this._get_preview_content(file_url, file_ext)}
                </div>
            </div>
        `);

        this.layout_main.append(this.drawer);
        this._bind_events(file_url);
        setTimeout(() => {
            this.drawer.addClass("open");
        }, 10);
    }

    _get_preview_content(file_url, file_ext) {
        if (file_ext === "pdf") {
            return `<iframe src="${file_url}" class="drawer-iframe"></iframe>`;
        } else if (["jpg", "jpeg", "png", "gif", "webp"].includes(file_ext)) {
            //TODO: not sure about this, need a way to zoom in images
            return `<div class="drawer-image-container"><img src="${file_url}" class="drawer-image" /></div>`;
        }
        return `
            <div class="drawer-fallback">
                <svg class="icon icon-xl"><use href="#icon-file"></use></svg>
                <p>${__("Preview not available")}</p>
                <a href="${file_url}" target="_blank" class="btn btn-primary btn-sm">${__(
            "Download"
        )}</a>
            </div>
        `;
    }

    _bind_events(file_url) {
        const self = this;

        // Close button
        this.drawer.find(".drawer-close-btn").on("click", () => {
            self.hide();
        });

        // Open in new tab
        this.drawer.find(".drawer-open-btn").on("click", () => {
            window.open(file_url, "_blank");
        });

        // Shrink width button
        this.drawer.find(".drawer-shrink-btn").on("click", () => {
            self._adjust_width(-self.step);
        });

        // Expand width button
        this.drawer.find(".drawer-expand-btn").on("click", () => {
            self._adjust_width(self.step);
        });

        // Close on escape key
        $(document).on("keydown.pending-file-drawer", (e) => {
            if (e.key === "Escape") {
                self.hide();
            }
        });

        // Clean up when navigating away
        // $(frappe.router).on("change.pending-file-drawer", () => {
        //     console.log("Route changed, destroying pending file drawer");
        //     self.destroy();
        // });
    }

    _adjust_width(delta) {
        // Update max_width in case window was resized
        this.max_width = Math.floor(window.innerWidth / 2);
        this.max_width = Math.floor(this.max_width / this.step) * this.step;

        const new_width = this.current_width + delta;

        if (new_width >= this.min_width && new_width <= this.max_width) {
            this.current_width = new_width;
            this.drawer.css({
                width: this.current_width + "px",
                "min-width": this.current_width + "px",
            });
        }

        // Update button states
        this.drawer
            .find(".drawer-shrink-btn")
            .prop("disabled", this.current_width <= this.min_width);
        this.drawer
            .find(".drawer-expand-btn")
            .prop("disabled", this.current_width >= this.max_width);
    }

    hide() {
        if (this.drawer) {
            this.drawer.removeClass("open");

            setTimeout(() => {
                this.destroy();
            }, 300);
        }
    }
    destroy() {
        $(".pending-file-drawer").remove();
        if (this.drawer) {
            this.drawer.remove();
            this.drawer = null;
        }
        this.layout_main = null;
        this.file_doc = null;
    }
};

invoice_helper.show_pending_file_drawer = function (frm) {
    if (frm._pending_file) {
        frm._pending_file_drawer = new invoice_helper.PendingFileDrawer(frm);
        frm._pending_file_drawer.show();
    }
};

invoice_helper.hide_pending_file_drawer = function (frm) {
    if (frm._pending_file_drawer) {
        frm._pending_file_drawer.destroy();
        frm._pending_file_drawer = null;
    }
};
