import { DEMOS } from "./demos";

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
