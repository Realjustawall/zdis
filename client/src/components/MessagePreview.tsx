import { useEffect, useState } from 'react';
import { decryptConversationMessage, readableEncryptedPreview } from '../lib/e2ee';
import { toPlainPreview } from '../lib/richText';

interface Props {
  content: string;
  encrypted?: boolean;
  encryptedContent?: string | null;
  conversationId?: string | null;
  authorId?: string;
  currentUserId: string;
  fallback: string;
  limit: number;
}

export function MessagePreview({
  content,
  encrypted = false,
  encryptedContent,
  conversationId,
  authorId,
  currentUserId,
  fallback,
  limit,
}: Props) {
  const [preview, setPreview] = useState(encrypted ? fallback : content);

  useEffect(() => {
    let active = true;
    if (!encrypted || !encryptedContent || !conversationId || !authorId) {
      setPreview(encrypted ? fallback : content);
      return () => { active = false; };
    }
    setPreview(fallback);
    decryptConversationMessage(encryptedContent, conversationId, currentUserId, authorId)
      .then((plaintext) => {
        if (active) setPreview(readableEncryptedPreview(plaintext));
      })
      .catch(() => {
        if (active) setPreview(fallback);
      });
    return () => { active = false; };
  }, [authorId, content, conversationId, currentUserId, encrypted, encryptedContent, fallback]);

  return <>{toPlainPreview(preview, limit)}</>;
}
