import { bind } from 'decko';
import { Component, h } from 'preact';
import { Xterm, XtermOptions } from './xterm';

import '@xterm/xterm/css/xterm.css';
import './mobile-input.css';
import { Modal } from '../modal';

interface Props extends XtermOptions {
    id: string;
}

interface State {
    modal: boolean;
    mobileInputVisible: boolean;
}

// Detect mobile (touch device with small screen)
const isMobile = () => {
    return (
        ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
        window.innerWidth <= 768
    );
};

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private xterm: Xterm;
    private mobileInput: HTMLTextAreaElement;
    private lastInputValue: string = '';

    constructor(props: Props) {
        super();
        this.xterm = new Xterm(props, this.showModal);
        this.state = {
            modal: false,
            mobileInputVisible: false,
        };
    }

    async componentDidMount() {
        await this.xterm.refreshToken();
        this.xterm.open(this.container);
        this.xterm.connect();

        // Listen for messages from parent frame
        window.addEventListener('message', (e) => {
            if (!e.data) return;

            // Scroll to bottom
            if (e.data.action === 'scrollToBottom' && (window as any).term) {
                (window as any).term.scrollToBottom();
            }

            // Send input to terminal (for drag-and-drop file paths)
            if (e.data.action === 'sendInput' && e.data.text && this.xterm) {
                this.xterm.sendData(e.data.text);
            }
        });

        // Mobile: tap terminal to show input overlay
        if (isMobile()) {
            this.container.addEventListener('click', this.showMobileInput);
        }
    }

    componentWillUnmount() {
        this.xterm.dispose();
        if (isMobile() && this.container) {
            this.container.removeEventListener('click', this.showMobileInput);
        }
    }

    render({ id }: Props, { modal, mobileInputVisible }: State) {
        return (
            <div id={id} ref={c => { this.container = c as HTMLElement; }}>
                <Modal show={modal}>
                    <label class="file-label">
                        <input onChange={this.sendFile} class="file-input" type="file" multiple />
                        <span class="file-cta">Choose files…</span>
                    </label>
                </Modal>
                {/* Mobile input - invisible textarea with stable position */}
                {isMobile() && (
                    <textarea
                        ref={c => {
                            this.mobileInput = c as HTMLTextAreaElement;
                            // Set spellcheck as string attribute for Gboard compatibility
                            if (c) c.setAttribute('spellcheck', 'false');
                        }}
                        class={`mobile-input-capture ${mobileInputVisible ? 'active' : ''}`}
                        onInput={this.handleMobileInput}
                        onKeyDown={this.handleMobileKeyDown}
                        onPaste={this.handleMobilePaste}
                        onBlur={this.hideMobileInput}
                        autocomplete="off"
                        autocorrect="off"
                        autocapitalize="off"
                    />
                )}
            </div>
        );
    }

    @bind
    showModal() {
        this.setState({ modal: true });
    }

    @bind
    sendFile(event: Event) {
        this.setState({ modal: false });
        const files = (event.target as HTMLInputElement).files;
        if (files) this.xterm.sendFile(files);
    }

    // ==================== Mobile Input Methods ====================

    private clearMobileInput() {
        if (this.mobileInput) {
            this.mobileInput.value = '';
        }
        this.lastInputValue = '';
    }

    @bind
    showMobileInput(e: Event) {
        // Don't activate mobile input if not connected (let xterm handle reconnect)
        if (!this.xterm.isConnected()) return;

        // Don't trigger if clicking on other inputs (file input, etc)
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT') return;
        if (target === this.mobileInput) {
            // Already focused, just ensure state is synced
            this.setState({ mobileInputVisible: true });
            return;
        }

        this.setState({ mobileInputVisible: true });
        requestAnimationFrame(() => {
            this.clearMobileInput();
            this.mobileInput?.focus();
        });
    }

    @bind
    hideMobileInput() {
        this.setState({ mobileInputVisible: false });
    }

    @bind
    handleMobileInput(e: Event) {
        const currentValue = (e.target as HTMLTextAreaElement).value;
        const lastValue = this.lastInputValue;

        // Send only the new characters (diff)
        // NOTE: This assumes edits happen at end of text. Mid-text cursor edits
        // will send wrong chars. Acceptable for mobile where sequential typing is typical.
        if (currentValue.length > lastValue.length) {
            // Characters added
            const newChars = currentValue.slice(lastValue.length);
            this.xterm.sendData(newChars);
        } else if (currentValue.length < lastValue.length) {
            // Characters deleted - send backspaces
            const deleteCount = lastValue.length - currentValue.length;
            for (let i = 0; i < deleteCount; i++) {
                this.xterm.sendData('\x7f');
            }
        }

        this.lastInputValue = currentValue;
    }

    @bind
    handleMobileKeyDown(e: KeyboardEvent) {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.xterm.sendData('\r');
            this.clearMobileInput();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.xterm.sendData('\x1b');
        } else if (e.ctrlKey && e.key === 'c') {
            e.preventDefault();
            this.xterm.sendData('\x03'); // SIGINT
        } else if (e.ctrlKey && e.key === 'd') {
            e.preventDefault();
            this.xterm.sendData('\x04'); // EOF
        }
    }

    @bind
    handleMobilePaste(e: ClipboardEvent) {
        e.preventDefault();
        const text = e.clipboardData?.getData('text');
        if (text) {
            this.xterm.sendData(text);
            // Sync state so next input diff is correct
            this.clearMobileInput();
        }
    }
}
