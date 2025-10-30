BUILDDIR := build/
NAME := ipvfoo
MANIFEST := src/manifest.json
MANIFEST_F := src/manifest/firefox-manifest.json
MANIFEST_C := src/manifest/chrome-manifest.json
VERSION_F := $(shell cat ${MANIFEST_F} | \
	sed -n 's/^ *"version": *"\([0-9.]\+\)".*/\1/p' | \
	head -n1)
VERSION_C := $(shell cat ${MANIFEST_C} | \
	sed -n 's/^ *"version": *"\([0-9.]\+\)".*/\1/p' | \
	head -n1)

all: prepare firefox chrome

prepare:
	@diff ${MANIFEST} ${MANIFEST_F} >/dev/null || \
		diff ${MANIFEST} ${MANIFEST_C} >/dev/null || \
		(echo "${MANIFEST} is not a copy of ${MANIFEST_F} or ${MANIFEST_C}; aborting."; exit 1)
	mkdir -p build

firefox: prepare
	rm -f ${BUILDDIR}${NAME}-${VERSION_F}.xpi
	cp -f ${MANIFEST_F} ${MANIFEST}
	(cd src && zip -9r ../${BUILDDIR}${NAME}-${VERSION_F}.xpi . -x "manifest/*")

chrome: prepare
	rm -f ${BUILDDIR}${NAME}-${VERSION_C}.zip
	cp -f ${MANIFEST_C} ${MANIFEST}
	(cd src && zip -9r ../${BUILDDIR}${NAME}-${VERSION_C}.zip . -x "manifest/*")

clean:
	rm -rf ${BUILDDIR}
