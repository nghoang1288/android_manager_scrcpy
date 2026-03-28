import { useEffect, useRef } from "react";
import { AndroidKeyCode } from "@yume-chan/scrcpy";
import { ScrcpyKeyboardInjector } from "./input.ts";
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from "@yume-chan/adb-scrcpy";

interface KeyboardControlProps {
    client: AdbScrcpyClient<AdbScrcpyOptions3_3_3<boolean>> | null;
    enabled: boolean;
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
        return false;
    }

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return true;
    }

    if (target instanceof HTMLElement && target.isContentEditable) {
        return true;
    }

    return target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null;
}

// Browser key code mapping to Android key code
const KEY_CODE_MAP: Record<string, AndroidKeyCode> = {
    'Backspace': AndroidKeyCode.Backspace,
    'Enter': AndroidKeyCode.Enter,
    'Escape': AndroidKeyCode.Escape,
    'Space': AndroidKeyCode.Space,
    'ArrowLeft': AndroidKeyCode.ArrowLeft,
    'ArrowRight': AndroidKeyCode.ArrowRight,
    'ArrowUp': AndroidKeyCode.ArrowUp,
    'ArrowDown': AndroidKeyCode.ArrowDown,
    'Delete': AndroidKeyCode.Delete,
    'Home': AndroidKeyCode.Home,
    'End': AndroidKeyCode.End,
    'PageUp': AndroidKeyCode.PageUp,
    'PageDown': AndroidKeyCode.PageDown,
    'Tab': AndroidKeyCode.Tab,
    'Insert': AndroidKeyCode.Insert,
    'CapsLock': AndroidKeyCode.CapsLock,
    'NumLock': AndroidKeyCode.NumLock,
    'ScrollLock': AndroidKeyCode.ScrollLock,
    'PrintScreen': AndroidKeyCode.PrintScreen,
    'Pause': AndroidKeyCode.Pause,
    'ContextMenu': AndroidKeyCode.ContextMenu,

    // Letters
    'KeyA': AndroidKeyCode.KeyA,
    'KeyB': AndroidKeyCode.KeyB,
    'KeyC': AndroidKeyCode.KeyC,
    'KeyD': AndroidKeyCode.KeyD,
    'KeyE': AndroidKeyCode.KeyE,
    'KeyF': AndroidKeyCode.KeyF,
    'KeyG': AndroidKeyCode.KeyG,
    'KeyH': AndroidKeyCode.KeyH,
    'KeyI': AndroidKeyCode.KeyI,
    'KeyJ': AndroidKeyCode.KeyJ,
    'KeyK': AndroidKeyCode.KeyK,
    'KeyL': AndroidKeyCode.KeyL,
    'KeyM': AndroidKeyCode.KeyM,
    'KeyN': AndroidKeyCode.KeyN,
    'KeyO': AndroidKeyCode.KeyO,
    'KeyP': AndroidKeyCode.KeyP,
    'KeyQ': AndroidKeyCode.KeyQ,
    'KeyR': AndroidKeyCode.KeyR,
    'KeyS': AndroidKeyCode.KeyS,
    'KeyT': AndroidKeyCode.KeyT,
    'KeyU': AndroidKeyCode.KeyU,
    'KeyV': AndroidKeyCode.KeyV,
    'KeyW': AndroidKeyCode.KeyW,
    'KeyX': AndroidKeyCode.KeyX,
    'KeyY': AndroidKeyCode.KeyY,
    'KeyZ': AndroidKeyCode.KeyZ,

    // Numbers
    'Digit0': AndroidKeyCode.Digit0,
    'Digit1': AndroidKeyCode.Digit1,
    'Digit2': AndroidKeyCode.Digit2,
    'Digit3': AndroidKeyCode.Digit3,
    'Digit4': AndroidKeyCode.Digit4,
    'Digit5': AndroidKeyCode.Digit5,
    'Digit6': AndroidKeyCode.Digit6,
    'Digit7': AndroidKeyCode.Digit7,
    'Digit8': AndroidKeyCode.Digit8,
    'Digit9': AndroidKeyCode.Digit9,

    // Symbols
    'Comma': AndroidKeyCode.Comma,
    'Period': AndroidKeyCode.Period,
    'Minus': AndroidKeyCode.Minus,
    'Equal': AndroidKeyCode.Equal,
    'BracketLeft': AndroidKeyCode.BracketLeft,
    'BracketRight': AndroidKeyCode.BracketRight,
    'Backslash': AndroidKeyCode.Backslash,
    'Semicolon': AndroidKeyCode.Semicolon,
    'Quote': AndroidKeyCode.Quote,
    'Slash': AndroidKeyCode.Slash,
    'Backquote': AndroidKeyCode.Backquote,

    // Function keys
    'F1': AndroidKeyCode.F1,
    'F2': AndroidKeyCode.F2,
    'F3': AndroidKeyCode.F3,
    'F4': AndroidKeyCode.F4,
    'F5': AndroidKeyCode.F5,
    'F6': AndroidKeyCode.F6,
    'F7': AndroidKeyCode.F7,
    'F8': AndroidKeyCode.F8,
    'F9': AndroidKeyCode.F9,
    'F10': AndroidKeyCode.F10,
    'F11': AndroidKeyCode.F11,
    'F12': AndroidKeyCode.F12,

    // Numpad Numbers
    'Numpad0': AndroidKeyCode.Numpad0,
    'Numpad1': AndroidKeyCode.Numpad1,
    'Numpad2': AndroidKeyCode.Numpad2,
    'Numpad3': AndroidKeyCode.Numpad3,
    'Numpad4': AndroidKeyCode.Numpad4,
    'Numpad5': AndroidKeyCode.Numpad5,
    'Numpad6': AndroidKeyCode.Numpad6,
    'Numpad7': AndroidKeyCode.Numpad7,
    'Numpad8': AndroidKeyCode.Numpad8,
    'Numpad9': AndroidKeyCode.Numpad9,

    // Numpad Operators
    'NumpadDivide': AndroidKeyCode.NumpadDivide,
    'NumpadMultiply': AndroidKeyCode.NumpadMultiply,
    'NumpadSubtract': AndroidKeyCode.NumpadSubtract,
    'NumpadAdd': AndroidKeyCode.NumpadAdd,
    'NumpadDecimal': AndroidKeyCode.NumpadDecimal,
    'NumpadEnter': AndroidKeyCode.NumpadEnter,

    // Modifiers
    'ShiftLeft': AndroidKeyCode.ShiftLeft,
    'ShiftRight': AndroidKeyCode.ShiftRight,
    'ControlLeft': AndroidKeyCode.ControlLeft,
    'ControlRight': AndroidKeyCode.ControlRight,
    'AltLeft': AndroidKeyCode.AltLeft,
    'AltRight': AndroidKeyCode.AltRight,
    'MetaLeft': AndroidKeyCode.MetaLeft,
    'MetaRight': AndroidKeyCode.MetaRight,
};

export function KeyboardControl({ client, enabled }: KeyboardControlProps) {
    const keyboardInjectorRef = useRef<ScrcpyKeyboardInjector | null>(null);

    useEffect(() => {
        if (!client || !enabled) return;

        // Create keyboard injector
        const keyboard = new ScrcpyKeyboardInjector(client);
        keyboardInjectorRef.current = keyboard;

        const handleKeyDown = async (e: KeyboardEvent) => {
            if (isEditableTarget(e.target)) {
                return;
            }

            // Special handling: Ctrl+V for clipboard paste
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
                e.preventDefault();
                e.stopPropagation();

                try {
                    // Read clipboard content
                    const text = await navigator.clipboard.readText();
                    if (text && client?.controller) {
                        // Paste via clipboard (supports Chinese/non-ASCII)
                        // 1. Set text to device clipboard
                        await client.controller.setClipboard({
                            sequence: 0n,  // 0n means do not wait for acknowledgement
                            paste: true,  // false means just set clipboard, true means paste
                            content: text
                        });


                    }
                } catch (err) {
                    console.error('Paste failed:', err);
                    console.warn('Please ensure clipboard permissions are granted');
                }
                return;
            }

            // Prevent default behavior (e.g., browser shortcuts)
            const androidKey = KEY_CODE_MAP[e.code];
            if (androidKey) {
                e.preventDefault();
                e.stopPropagation();
                await keyboard.down(androidKey);
            }
        };

        const handleKeyUp = async (e: KeyboardEvent) => {
            if (isEditableTarget(e.target)) {
                return;
            }

            // Ctrl+V handled in keydown
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            const androidKey = KEY_CODE_MAP[e.code];
            if (androidKey) {
                e.preventDefault();
                e.stopPropagation();
                await keyboard.up(androidKey);
            }
        };

        // Add global keyboard listeners
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);

        return () => {
            // Cleanup
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            keyboard.reset();
            keyboard.dispose();
            keyboardInjectorRef.current = null;
        };
    }, [client, enabled]);

    return null; // No UI
}

