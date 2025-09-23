(function () {
    const LOG_SERVER_URL = (window.__HOME_BRAIN_LOG_URL || window.__HB_LOG_URL || "/logs");
    const logBuffer = [];
    const MAX_BUFFER_SIZE = 100; // Limit buffer size to prevent memory issues
    let isBufferChanged = false; // Flag to track if new logs have been added

    // Function to add a log to the buffer, keeping only the latest logs
    function addToBuffer(log) {
        // If buffer is full, remove the oldest entry (first item)
        if (logBuffer.length >= MAX_BUFFER_SIZE) {
            logBuffer.shift(); // Remove oldest log
        }

        // Add the new log
        logBuffer.push(log);

        // Mark buffer as changed
        isBufferChanged = true;
    }

    // Function to collect DOM metrics
    function collectDOMMetrics() {
        try {
            const body = document.body;
            const totalElements = document.querySelectorAll('*').length;

            return {
                totalElements,
                documentReadyState: document.readyState,
                isBlankScreen: body && totalElements < 15 && body.textContent.trim().length === 0,
            };
        } catch (error) {
            return {};
        }
    }

    function sendLogs() {
        if (logBuffer.length === 0) return;

        // Only send if buffer has changed since last send
        if (!isBufferChanged) {
            return; // No changes, don't send
        }

        // Reset the changed flag before sending
        isBufferChanged = false;

        // Collect DOM metrics to send along with logs
        const domMetrics = collectDOMMetrics();

        // Send ALL logs in the buffer along with DOM metrics
        fetch(LOG_SERVER_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                logs: logBuffer,
                domMetrics: domMetrics
            }),
        }).catch((err) => {
            // Mark as changed again so we'll retry on next interval
            isBufferChanged = true;
        });
    }

    const consoleMethods = ["log", "error", "warn", "info", "debug"];

    consoleMethods.forEach((method) => {
        const originalMethod = console[method];
        console[method] = function (...args) {
            const timestamp = new Date().toISOString();

            const message = args
                .map((arg) => {
                    if (arg instanceof Error) {
                        return `${arg.name}: ${arg.message}\n${arg.stack || ""}`;
                    } else if (typeof arg === "object" && arg !== null) {
                        try {
                            // Handle React component stack traces specially
                            if (arg.componentStack) {
                                return `${String(arg.message)}\nComponent Stack:${arg.componentStack
                                }`;
                            }
                            return JSON.stringify(arg);
                        } catch (e) {
                            return "[Circular]";
                        }
                    } else {
                        return String(arg);
                    }
                })
                .join(" ");

            addToBuffer({
                method,
                message: message.trim(),
                timestamp,
            });

            originalMethod.apply(console, args);
        };
    });

    // Capture unhandled JavaScript errors
    window.onerror = function (message, source, lineno, colno, error) {
        const timestamp = new Date().toISOString();
        const errorName = error && error.name ? error.name : "Error";

        addToBuffer({
            method: "error",
            message: `${errorName}: ${message} at ${source}:${lineno}:${colno}`,
            timestamp,
        });
    };

    // Capture resource loading errors - using throttling to prevent overwhelming
    let lastResourceErrorTime = 0;
    window.addEventListener(
        "error",
        (event) => {
            const now = Date.now();
            if (now - lastResourceErrorTime < 500) return; // Throttle to max one per 500ms
            lastResourceErrorTime = now;

            if (
                event.target instanceof HTMLImageElement ||
                event.target instanceof HTMLScriptElement ||
                event.target instanceof HTMLLinkElement
            ) {
                const timestamp = new Date().toISOString();
                addToBuffer({
                    method: "error",
                    message: `Resource error: ${event.target.tagName
                    } failed to load. URL: ${event.target.src || event.target.href}`,
                    timestamp,
                });
            }
        },
        true
    );

    // Periodically send logs every 3 seconds
    setInterval(sendLogs, 3000);

    // Send remaining logs on page unload
    window.addEventListener("beforeunload", sendLogs);
})();


/**
 * URL Tracker for VS Code Extension Product View
 *
 * Add this code to your app that runs inside the iframe to enable
 * URL synchronization with the VS Code extension's URL bar.
 *
 * This works by detecting URL changes in your app and sending them
 * to the parent frame via postMessage.
 */

(function () {
    let currentUrl = window.location.href;

    /**
     * Send URL change notification to parent frame
     */
    function notifyUrlChange(newUrl) {
        if (window.parent && window.parent !== window) {
            console.log('[IframeApp] Sending URL change to parent:', newUrl);

            window.parent.postMessage({
                type: 'urlChanged',
                url: newUrl
            }, '*'); // Using '*' for simplicity, but you could restrict to specific origins
        }
    }

    /**
     * Check if URL has changed and notify if so
     */
    function checkUrlChange() {
        const newUrl = window.location.href;
        if (newUrl !== currentUrl) {
            currentUrl = newUrl;
            notifyUrlChange(newUrl);
        }
    }

    // Method 1: Listen for popstate events (browser back/forward navigation)
    window.addEventListener('popstate', function (event) {
        setTimeout(checkUrlChange, 0); // Use timeout to ensure URL is updated
    });

    // Method 2: Override history.pushState and history.replaceState for SPA navigation
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
        originalPushState.apply(history, args);
        setTimeout(checkUrlChange, 0);
    };

    history.replaceState = function (...args) {
        originalReplaceState.apply(history, args);
        setTimeout(checkUrlChange, 0);
    };

    // Method 3: Poll for URL changes as fallback (useful for some routing libraries)
    setInterval(checkUrlChange, 1000);

    // Method 4: Listen for hashchange events
    window.addEventListener('hashchange', function (event) {
        setTimeout(checkUrlChange, 0);
    });

    // Send initial URL when the script loads
    window.addEventListener('load', function () {
        notifyUrlChange(currentUrl);
    });

    // Send URL immediately if document is already loaded
    if (document.readyState === 'complete') {
        notifyUrlChange(currentUrl);
    }
})();

const isFramed = (() => {
    try {
        return window.self !== window.top;
    } catch {
        return true;
    }
})();

if (isFramed) {
    document.addEventListener('keydown', e => {
        const isClipboardOperation = (e.ctrlKey || e.metaKey) && ['c', 'x', 'v'].includes(e.key.toLowerCase()) && !e.repeat;
        const isSelectionOperation = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !e.repeat;
        const isUndoRedoOperation = (e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase()) && !e.repeat;

        if (!isClipboardOperation && !isSelectionOperation && !isUndoRedoOperation) {
            return;
        }

        const message = {
            type: 'iframe-keydown-event',
            keydown: {
                altKey: e.altKey,
                code: e.code,
                ctrlKey: e.ctrlKey,
                isComposing: e.isComposing,
                key: e.key,
                location: e.location,
                metaKey: e.metaKey,
                repeat: e.repeat,
                shiftKey: e.shiftKey
            },
            selection: {},
            operation: null,
            keyToLowerCase: e.key.toLowerCase(),
        };

        if (isClipboardOperation) {
            message.operation = 'clipboard';

            if (['c', 'x'].includes(message.keyToLowerCase)) {
                const selection = window.getSelection();
                if (selection?.rangeCount && selection.rangeCount > 0) {
                    message.selection = selection.toString();
                }
            }

            if (message.keyToLowerCase === 'x') {
                document.execCommand('delete', false, null);
            }
            e.preventDefault();
            e.stopPropagation();
            window.parent.postMessage(message, '*');
        } else if (isSelectionOperation) {
            message.operation = 'select-all';
            document.execCommand('selectAll', false, null);
            e.preventDefault();
            e.stopPropagation();
            return;
        } else if (isUndoRedoOperation) {
            message.operation = e.key.toLowerCase() === 'z' ? 'undo' : 'redo';
            document.execCommand(message.operation, false, null);
            return;
        } else {
            // No action
        }
    });

    window.addEventListener('message', (e) => {
        if (e.data.type === 'perform-paste') {
            const { text, modifiers } = e.data;

            try {
                if (document.execCommand) {
                    const success = document.execCommand('insertText', false, text);
                    if (!success) {
                        throw new console.error('paste execCommand failed');
                    }
                }
            } catch (error) {
                console.error('Paste handling failed:', error);
            }
        }
    });
}
