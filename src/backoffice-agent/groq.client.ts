import { Injectable, Logger } from '@nestjs/common';
import { BackofficeAgentConfig } from './backoffice-agent.config.js';

/* Client HTTP minimal vers le provider IA (endpoint compatible OpenAI).
 * Code nouveau volontairement simple (aucune réutilisation de l'ancienne
 * infrastructure IA supprimée) : un seul appel `chat()` (messages + outils),
 * timeout, erreurs propres. Aucune clé ni contenu sensible dans les logs
 * (statut + durée uniquement). */

export interface GroqToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface GroqChatChoice {
  content: string | null;
  toolCalls: GroqToolCall[];
  finishReason: string | null;
}

export class GroqClientError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'GroqClientError';
  }
}

interface ChatInput {
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string; name?: string }>;
  tools: unknown[];
}

@Injectable()
export class GroqClient {
  private readonly logger = new Logger(GroqClient.name);

  constructor(private readonly agentConfig: BackofficeAgentConfig) {}

  async chat(input: ChatInput): Promise<GroqChatChoice> {
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.agentConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.agentConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.agentConfig.model,
          messages: input.messages,
          tools: input.tools,
          tool_choice: 'auto',
        }),
        signal: AbortSignal.timeout(this.agentConfig.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GroqClientError('Le service IA ne répond pas (délai dépassé).', false);
      }
      throw new GroqClientError('Service IA injoignable (erreur réseau).', true);
    }
    const durationMs = Date.now() - startedAt;
    if (res.status === 429) {
      this.logger.warn(`Groq 429 (durée ${durationMs} ms).`);
      throw new GroqClientError('Service IA saturé, réessayez dans un instant.', true);
    }
    if (res.status === 401 || res.status === 403) {
      this.logger.warn(`Groq ${res.status} (durée ${durationMs} ms).`);
      throw new GroqClientError("L'assistant est momentanément indisponible.", false);
    }
    if (!res.ok) {
      this.logger.warn(`Groq ${res.status} (durée ${durationMs} ms).`);
      throw new GroqClientError("L'assistant est momentanément indisponible.", res.status >= 500);
    }
    let body: {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string | null;
      }>;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new GroqClientError("Réponse du service IA illisible.", false);
    }
    const message = body.choices?.[0]?.message;
    if (!message) {
      throw new GroqClientError("Réponse du service IA vide.", false);
    }
    const toolCalls: GroqToolCall[] = (message.tool_calls ?? [])
      .filter((call) => typeof call.function?.name === 'string')
      .map((call, index) => ({
        id: typeof call.id === 'string' ? call.id : `call-${index}`,
        name: call.function?.name as string,
        argumentsJson: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}',
      }));
    return {
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls,
      finishReason: body.choices?.[0]?.finish_reason ?? null,
    };
  }
}
