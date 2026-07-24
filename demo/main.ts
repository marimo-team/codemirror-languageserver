import { DEMOS } from "./demos";
import {
    type ThemeMode,
    getThemeMode,
    initPageTheme,
    onThemeChange,
    toggleThemeMode,
} from "./shared/theme";

// ---- Theme toggle ---------------------------------------------------------
initPageTheme();

const SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;

const toggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
if (toggle) {
    const render = (mode: ThemeMode) => {
        // Show the icon/label for the theme you'd switch *to*.
        toggle.innerHTML =
            mode === "dark"
                ? `${SUN}<span>Light</span>`
                : `${MOON}<span>Dark</span>`;
    };
    render(getThemeMode());
    onThemeChange(render);
    toggle.addEventListener("click", () => toggleThemeMode());
}

// ---- Tabs -----------------------------------------------------------------
const tabs = document.querySelector<HTMLElement>("#tabs");
const root = document.querySelector<HTMLElement>("#demo-root");

if (tabs && root) {
    let dispose: (() => void) | null = null;
    const buttons: HTMLButtonElement[] = [];

    const activate = (index: number) => {
        const demo = DEMOS[index];
        if (!demo) {
            return;
        }
        // Tear down the previous demo (destroys its editor + terminates its
        // worker) before mounting the next one.
        dispose?.();
        dispose = null;
        root.replaceChildren();

        for (const [i, button] of buttons.entries()) {
            button.classList.toggle("active", i === index);
        }

        const container = document.createElement("div");
        root.appendChild(container);
        dispose = demo.mount(container);
    };

    for (const [index, demo] of DEMOS.entries()) {
        const button = document.createElement("button");
        button.textContent = demo.label;
        button.className = "tab";
        button.addEventListener("click", () => activate(index));
        buttons.push(button);
        tabs.appendChild(button);
    }

    activate(0);
}
