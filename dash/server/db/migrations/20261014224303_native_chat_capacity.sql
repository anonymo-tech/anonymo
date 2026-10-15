-- Request reservations now follow the selected model's native completion capacity.
-- Positive integer validation stays in place; all existing quotes remain valid.
ALTER TABLE quotes DROP CONSTRAINT quotes_max_output_tokens_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_max_output_tokens_check CHECK (max_output_tokens > 0);
