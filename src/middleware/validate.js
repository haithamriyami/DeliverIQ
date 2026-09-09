import { HttpError } from './errorHandler.js';

export function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });

    if (!result.success) {
      return next(
        new HttpError(400, 'Validation failed', result.error.flatten())
      );
    }

    req.validated = result.data;
    next();
  };
}
