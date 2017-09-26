BUILDDIR := build/
NAME     := ipvfoo
VERSION  := $(shell cat src/manifest.json | \
              sed -n 's/^ *"version": *"\([0-9.]\+\)".*/\1/p' | \
              head -n1)

all: prepare firefox chrome

prepare:
	mkdir -p build

firefox: prepare
	rm -f ${BUILDDIR}${NAME}-${VERSION}.xpi
	cd src && zip -9r ../${BUILDDIR}${NAME}-${VERSION}.xpi *

chrome: prepare
	rm -f ${BUILDDIR}${NAME}-${VERSION}.zip
	zip -9r ${BUILDDIR}${NAME}-${VERSION}.zip src

clean:
	rm -rf ${BUILDDIR}
