import { bind } from 'decko';
import { Component, h } from 'preact';
import { Xterm, XtermOptions } from './xterm';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';

interface Props extends XtermOptions {
    id: string;
}

interface State {
    modal: boolean;
}

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private xterm: Xterm;

    constructor(props: Props) {
        super();
        this.xterm = new Xterm(props, this.showModal);
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
    }

    componentWillUnmount() {
        this.xterm.dispose();
    }

    render({ id }: Props, { modal }: State) {
        return (
            <div id={id} ref={c => { this.container = c as HTMLElement; }}>
                <Modal show={modal}>
                    <label class="file-label">
                        <input onChange={this.sendFile} class="file-input" type="file" multiple />
                        <span class="file-cta">Choose files…</span>
                    </label>
                </Modal>
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
}
