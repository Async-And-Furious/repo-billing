export default {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    '!src/**/*module.ts',
    '!src/main.ts',
    '!src/**/events/*.ts',
    '!src/**/value-objects/index.ts',
    '!src/**/ports/*.ts',
    '!src/auth/decorators/*.ts',
    '!src/auth/dto/*.ts',
    '!src/auth/strategies/*.ts',
    '!src/auth/enums/*.ts',
    '!src/**/dto/*.ts',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  // Agente desligado em toda a suíte: o kafka-trace importa `newrelic`, que tentaria subir sem config.
  setupFiles: ['<rootDir>/test/support/newrelic-desligado.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', 'jest-e2e.json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transformIgnorePatterns: ['node_modules/(?!(bcrypt)/)'],
  coverageReporters: ['lcov', 'text', 'clover'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
