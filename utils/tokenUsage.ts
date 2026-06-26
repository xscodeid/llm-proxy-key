import { TokenUsage } from '../types';

export function extractUsageFromChunk(chunkContent: string): TokenUsage | null {
  try {
    const lines = chunkContent.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      if (!trimmedLine || !trimmedLine.startsWith('data: ')) {
        continue;
      }
      
      const jsonStr = trimmedLine.slice(6);
      
      if (jsonStr === '[DONE]') {
        continue;
      }
      
      try {
        const data = JSON.parse(jsonStr);
        
        if (data.usage && data.usage.total_tokens) {
          return {
            total_tokens: data.usage.total_tokens,
            prompt_tokens: data.usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens,
            prompt_tokens_details: data.usage.prompt_tokens_details || null
          };
        }
      } catch (parseError) {
        continue;
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

export function logTokenUsage(usage: TokenUsage): void {
  const cached = usage.prompt_tokens_details?.cached_tokens;
  // Async logging to avoid blocking the event loop during streaming.
  setImmediate(() => {
    console.log(
      `  ┌─ [Tokens]\n` +
      `  │  Total   : ${usage.total_tokens.toLocaleString()}\n` +
      `  │  Prompt  : ${usage.prompt_tokens.toLocaleString()}\n` +
      `  │  Output  : ${usage.completion_tokens.toLocaleString()}\n` +
      (cached ? `  │  Cached  : ${cached.toLocaleString()}\n` : "") +
      `  └─`
    );
  });
}