ENTRY(_start)
SECTIONS {
    . = 0x00000000;
    .init : { *(.init) }
    .data : { *(.data) }
    .text : { *(.text) }
}
