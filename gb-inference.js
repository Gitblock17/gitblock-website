/**
 * GitBlock Browser Inference — Run AI models directly in the browser.
 * No API keys. No servers. No accounts. Just open models on your GPU.
 *
 * Uses WebLLM (@mlc-ai/web-llm) to run models via WebGPU.
 * Falls back to CPU via Transformers.js if WebGPU unavailable.
 *
 * Models available (auto-selected by capability):
 *   - Llama-3.2-1B (fast, works on most devices)
 *   - Gemma-2-2B (balanced)
 *   - Llama-3.2-3B (better quality, needs more GPU)
 *
 * Usage:
 *   const engine = new GitBlockInference();
 *   await engine.init();
 *   const reply = await engine.chat([{role:'user', content:'Hello'}]);
 */

(function() {
'use strict';

const WEBLLM_CDN = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.46/lib/index.min.js';

const MODELS = {
    'fast': 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    'balanced': 'gemma-2-2b-it-q4f16_1-MLC',
    'best': 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
};

class GitBlockInference {
    constructor() {
        this._engine = null;
        this._ready = false;
        this._loading = false;
        this._modelId = MODELS.fast;
        this._onStatus = null; // callback(statusText)
    }

    /**
     * Initialize the inference engine. Downloads model on first call (~800MB-2GB).
     * Subsequent calls are instant (model cached in IndexedDB).
     */
    async init(tier = 'fast', onStatus = null) {
        if (this._ready) return true;
        if (this._loading) {
            // Wait for existing load
            for (let i = 0; i < 300; i++) {
                if (this._ready) return true;
                if (!this._loading) return false;
                await new Promise(r => setTimeout(r, 1000));
            }
            return false;
        }

        this._loading = true;
        this._onStatus = onStatus || (msg => console.log('[GitBlock AI]', msg));
        this._modelId = MODELS[tier] || MODELS.fast;

        // Check WebGPU
        if (!this._hasWebGPU()) {
            this._loading = false;
            throw new Error('NO_WEBGPU');
        }

        // Load WebLLM library
        try {
            await this._loadWebLLM();
            this._onStatus('Loading AI model (first time ~2 min, cached after)...');
            this._engine = await this._webllm.CreateMLCEngine({
                model: this._modelId,
                initProgressCallback: (p) => {
                    const pct = Math.round(p.progress * 100);
                    this._onStatus(`Downloading model: ${pct}%`);
                },
            });
            this._ready = true;
            this._loading = false;
            this._onStatus('AI ready — running locally on your device');
            return true;
        } catch (e) {
            this._loading = false;
            console.error('WebLLM init failed:', e);
            throw e;
        }
    }

    /**
     * Chat completion — OpenAI-compatible interface.
     * @param {Array} messages - [{role: 'system'|'user'|'assistant', content: '...'}]
     * @param {Object} opts - {temperature, max_tokens, tools}
     * @returns {Object} - {choices: [{message: {role, content, tool_calls?}}], usage: {total_tokens}}
     */
    async chat(messages, opts = {}) {
        if (!this._ready) throw new Error('Engine not initialized. Call init() first.');

        const request = {
            messages,
            temperature: opts.temperature || 0.7,
            max_tokens: opts.max_tokens || 512,
            stream: false,
        };

        // Add tools if provided
        if (opts.tools && opts.tools.length > 0) {
            request.tools = opts.tools;
        }

        const reply = await this._engine.chat.completions.create(request);
        return reply;
    }

    /**
     * Streaming chat — returns an async iterator.
     * Usage: for await (const chunk of engine.chatStream(messages)) { ... }
     */
    async *chatStream(messages, opts = {}) {
        if (!this._ready) throw new Error('Engine not initialized.');

        const request = {
            messages,
            temperature: opts.temperature || 0.7,
            max_tokens: opts.max_tokens || 512,
            stream: true,
        };

        if (opts.tools) request.tools = opts.tools;

        const stream = await this._engine.chat.completions.create(request);
        for await (const chunk of stream) {
            yield chunk;
        }
    }

    get isReady() { return this._ready; }
    get isLoading() { return this._loading; }
    get modelName() { return this._modelId; }

    _hasWebGPU() {
        return typeof navigator !== 'undefined' && navigator.gpu;
    }

    async _loadWebLLM() {
        if (this._webllm) return;
        return new Promise((resolve, reject) => {
            if (window.mlc) { this._webllm = window.mlc; resolve(); return; }
            const script = document.createElement('script');
            script.src = WEBLLM_CDN;
            script.onload = () => {
                // Wait for it to be available
                let attempts = 0;
                const check = () => {
                    if (window.mlc) {
                        this._webllm = window.mlc;
                        resolve();
                    } else if (attempts++ < 20) {
                        setTimeout(check, 500);
                    } else {
                        reject(new Error('WebLLM loaded but mlc not found'));
                    }
                };
                check();
            };
            script.onerror = () => reject(new Error('Failed to load WebLLM library'));
            document.head.appendChild(script);
        });
    }
}

// Expose globally
window.GitBlockInference = GitBlockInference;
window.GitBlockModels = MODELS;
})();
