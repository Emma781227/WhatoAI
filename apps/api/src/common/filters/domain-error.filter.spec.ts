import type { ArgumentsHost } from '@nestjs/common';
import { EmailAlreadyUsedError, InvalidCredentialsError } from '@whauto/shared';

import { DomainErrorFilter } from './domain-error.filter';

function hostWithResponse() {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('DomainErrorFilter', () => {
  const filter = new DomainErrorFilter();

  it('mappe une DomainError vers son statut HTTP et son code métier', () => {
    const { host, response } = hostWithResponse();
    filter.catch(new EmailAlreadyUsedError(), host);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 409,
      code: 'EMAIL_ALREADY_USED',
      message: expect.any(String),
    });
  });

  it('ne fuite aucun détail interne (uniquement statusCode, code, message)', () => {
    const { host, response } = hostWithResponse();
    filter.catch(new InvalidCredentialsError(), host);

    const body = response.json.mock.calls[0][0];
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'statusCode']);
  });
});
