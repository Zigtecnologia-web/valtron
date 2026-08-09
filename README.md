# Valtron

Valtron e uma ferramenta desktop de analise local de dados tabulares: um mini data studio baseado em DuckDB para importar, consultar, validar e explorar arquivos Excel/CSV sem depender de nuvem.

Ele foi desenhado para ingerir arquivos gigantescos em poucos segundos, persistindo os dados localmente em DuckDB e mantendo a interface leve por meio de paginacao, filtros, ordenacao e consultas SQL somente leitura.

## Documentacao

- [Documentacao tecnica do projeto](docs/PROJETO.md)

## Requisitos

- Node.js 20+
- Rust toolchain com `cargo`
- Dependencias de sistema do Tauri para o seu sistema operacional

## Rodando em desenvolvimento

```bash
npm install
npm run tauri:dev
```

## Build

```bash
npm run tauri:build
```

No macOS, o build padrao gera:

```text
src-tauri/target/release/bundle/macos/Valtron.app
```

## Estrutura

- `src/`: frontend TypeScript servido pelo Vite
- `src-tauri/`: aplicacao Tauri, comandos Rust e persistencia DuckDB
- `src-tauri/src/lib.rs`: importacao XLSX, criacao da tabela `xlsx_rows` e paginacao da grid

## Importacao XLSX

O botao `Importar XLSX` abre o seletor nativo do sistema. O Rust recebe o caminho do arquivo, importa a primeira planilha para o DuckDB local e a tela carrega os dados em paginas de 100 linhas para manter a interface leve com arquivos grandes.
